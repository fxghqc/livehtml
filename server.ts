import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { Client as MinioClient } from "minio";

const PORT = Number(process.env.PORT || 8787);
const ROOT = import.meta.dir;
const STATE_DIR = join(ROOT, "state");
const PUBLIC_DIR = join(ROOT, "public");
const EXAMPLES_DIR = join(ROOT, "examples");
const SKILL_DIR = join(ROOT, "skill");
const MAX_HTML_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_WAIT_SEC = 60;

// Long-poll opaque etag is `<bootId>:<version>`. bootId changes every process
// restart so clients whose etag predates restart get a `reset` response.
const bootId = crypto.randomUUID();
const versionByRoom = new Map<string, number>();

await mkdir(STATE_DIR, { recursive: true });

// ---- MinIO client (optional; if unset, /pages endpoints return 503) ----

const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT || "";
const MINIO_BUCKET = process.env.MINIO_BUCKET || "pages";

let minio: MinioClient | null = null;
if (MINIO_ENDPOINT) {
  const [host, portStr] = MINIO_ENDPOINT.split(":");
  minio = new MinioClient({
    endPoint: host,
    port: Number(portStr || (process.env.MINIO_USE_SSL === "true" ? 443 : 9000)),
    useSSL: process.env.MINIO_USE_SSL === "true",
    accessKey: process.env.MINIO_ACCESS_KEY || "",
    secretKey: process.env.MINIO_SECRET_KEY || "",
  });
  try {
    if (!(await minio.bucketExists(MINIO_BUCKET))) {
      await minio.makeBucket(MINIO_BUCKET);
      console.log(`[minio] created bucket "${MINIO_BUCKET}"`);
    }
    console.log(`[minio] connected to ${MINIO_ENDPOINT}, bucket="${MINIO_BUCKET}"`);
  } catch (e) {
    console.error(`[minio] init failed:`, e);
    minio = null;
  }
}

type RoomState = Record<string, unknown>;
type Peer = { id: string; room: string; user: unknown };
type WsData = { peer: Peer };

const rooms = new Map<string, RoomState>();
const writeTimers = new Map<string, ReturnType<typeof setTimeout>>();
const writeChains = new Map<string, Promise<void>>();
const peersByRoom = new Map<string, Set<ServerWebSocket<WsData>>>();

// Phase C — per-key metadata kept parallel to `rooms` (flat). Disk
// envelope: { version: 2, fields: { key: { v, ts, by } } }. Format
// detection uses the top-level `version` field only, never field shape.
type FieldMeta = { ts: string; by: string };
const metaByRoom = new Map<string, Record<string, FieldMeta>>();

function setKeyMeta(room: string, key: string, by: string) {
  let m = metaByRoom.get(room);
  if (!m) {
    m = {};
    metaByRoom.set(room, m);
  }
  m[key] = { ts: new Date().toISOString(), by };
}

function delKeyMeta(room: string, key: string) {
  const m = metaByRoom.get(room);
  if (m) delete m[key];
}

function replaceRoomMeta(room: string, keys: string[], by: string) {
  const now = new Date().toISOString();
  const m: Record<string, FieldMeta> = {};
  for (const k of keys) m[k] = { ts: now, by };
  metaByRoom.set(room, m);
}

function sanitizeRoom(name: string): string {
  let r = String(name ?? "")
    .replace(/\.\./g, "_")
    .replace(/[^a-zA-Z0-9/_.-]/g, "_")
    .replace(/\/+/g, "/")
    .replace(/^\/+|\/+$/g, "");
  if (!r) r = "default";
  return r.slice(0, 200);
}

function roomFile(room: string): string {
  return join(STATE_DIR, room.replace(/\//g, "__") + ".json");
}

async function loadRoom(room: string): Promise<RoomState> {
  const cached = rooms.get(room);
  if (cached) return cached;
  let state: RoomState = {};
  let meta: Record<string, FieldMeta> = {};
  const file = roomFile(room);
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(await readFile(file, "utf8"));
      if (
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        parsed.version === 2 &&
        parsed.fields &&
        typeof parsed.fields === "object" &&
        !Array.isArray(parsed.fields)
      ) {
        // New envelope format.
        for (const [k, entry] of Object.entries(parsed.fields as Record<string, any>)) {
          if (entry && typeof entry === "object" && "v" in entry) {
            state[k] = entry.v;
            meta[k] = {
              ts: typeof entry.ts === "string" ? entry.ts : "",
              by: typeof entry.by === "string" ? entry.by : "",
            };
          }
        }
      } else if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        // Legacy flat format. Meta stays empty until next write.
        state = parsed as RoomState;
      }
    } catch (e) {
      console.warn(`[warn] failed to parse ${file}, starting empty:`, e);
    }
  }
  rooms.set(room, state);
  metaByRoom.set(room, meta);
  return state;
}

function scheduleSave(room: string) {
  const existing = writeTimers.get(room);
  if (existing) clearTimeout(existing);
  writeTimers.set(
    room,
    setTimeout(() => doSave(room), 300),
  );
}

async function doSave(room: string) {
  writeTimers.delete(room);
  const prev = writeChains.get(room) ?? Promise.resolve();
  const next = prev
    .then(async () => {
      const state = rooms.get(room) ?? {};
      const meta = metaByRoom.get(room) ?? {};
      const fields: Record<string, { v: unknown; ts: string; by: string }> = {};
      for (const k of Object.keys(state)) {
        const m = meta[k];
        fields[k] = { v: state[k], ts: m?.ts ?? "", by: m?.by ?? "" };
      }
      const envelope = { version: 2, fields };
      const file = roomFile(room);
      const tmp = file + ".tmp";
      await writeFile(tmp, JSON.stringify(envelope, null, 2));
      await rename(tmp, file);
    })
    .catch((e) => console.error(`[error] save ${room}:`, e));
  writeChains.set(room, next);
  await next;
}

function presenceList(room: string) {
  const set = peersByRoom.get(room);
  if (!set) return [];
  return Array.from(set).map((ws) => ({ id: ws.data.peer.id, user: ws.data.peer.user }));
}

function broadcast(room: string, msg: unknown, except?: ServerWebSocket<WsData>) {
  const set = peersByRoom.get(room);
  if (!set) return;
  const payload = JSON.stringify(msg);
  for (const ws of set) if (ws !== except) ws.send(payload);
}

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, DELETE, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

async function serveStatic(
  baseDir: string,
  relPath: string,
  contentType?: string,
): Promise<Response | null> {
  const normalized = relPath.replace(/^\/+/, "");
  if (normalized.includes("..")) return null;
  const path = join(baseDir, normalized);
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  const headers: Record<string, string> = { ...CORS };
  if (contentType) headers["Content-Type"] = contentType;
  return new Response(file, { headers });
}

// ---- /pages helpers ----

function sanitizePageKey(raw: string): string {
  let decoded: string;
  try { decoded = decodeURIComponent(raw); } catch { return ""; }
  if (decoded.includes("..")) return "";
  const cleaned = decoded
    .replace(/[^a-zA-Z0-9/_.-]/g, "_")
    .replace(/\/+/g, "/")
    .replace(/^\/+|\/+$/g, "");
  if (!cleaned) return "";
  return cleaned.slice(0, 500);
}

// Room id used by sync.js when HTML is served at /pages/<key>.
// sync.js uses location.pathname by default, which becomes "/pages/<key>",
// sanitizeRoom() strips the leading slash, so the room is "pages/<key>".
function roomForPageKey(key: string): string {
  return sanitizeRoom("pages/" + key);
}

async function readBodyToBuffer(req: Request): Promise<Buffer | null> {
  const buf = await req.arrayBuffer();
  if (buf.byteLength === 0 || buf.byteLength > MAX_HTML_SIZE) return null;
  return Buffer.from(buf);
}

async function streamMinioObject(key: string): Promise<Buffer> {
  const stream = await minio!.getObject(MINIO_BUCKET, key);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function jsonResp(body: unknown, status = 200) {
  return Response.json(body, { status, headers: CORS });
}
function errResp(msg: string, status: number) {
  return new Response(msg, { status, headers: CORS });
}

async function handleStateRoom(req: Request, room: string): Promise<Response | null> {
  if (req.method === "GET") {
    const state = await loadRoom(room);
    const url = new URL(req.url);
    if (url.searchParams.get("meta") === "1") {
      const meta = metaByRoom.get(room) ?? {};
      const fields: Record<string, { v: unknown; ts: string; by: string }> = {};
      for (const k of Object.keys(state)) {
        const m = meta[k];
        fields[k] = { v: state[k], ts: m?.ts ?? "", by: m?.by ?? "" };
      }
      return Response.json({ version: 2, fields }, { headers: CORS });
    }
    return Response.json(state, { headers: CORS });
  }
  if (req.method === "PUT") {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return new Response("invalid json", { status: 400, headers: CORS });
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return new Response("body must be a JSON object", { status: 400, headers: CORS });
    }
    rooms.set(room, body as RoomState);
    replaceRoomMeta(room, Object.keys(body as RoomState), "http");
    scheduleSave(room);
    broadcast(room, { t: "replace", state: body, by: "http" });
    bumpAndNotify(room);
    return Response.json({ ok: true, room }, { headers: CORS });
  }
  if (req.method === "DELETE") {
    rooms.set(room, {});
    metaByRoom.set(room, {});
    scheduleSave(room);
    broadcast(room, { t: "replace", state: {}, by: "http" });
    bumpAndNotify(room);
    return Response.json({ ok: true, room }, { headers: CORS });
  }
  return null;
}

// ---- Long-poll machinery (Phase B) ----

type Waiter = {
  resolveRaw: (resp: Response) => void;
  timer: ReturnType<typeof setTimeout>;
  signal: AbortSignal;
  abortHandler: () => void;
  room: string;
  settled: boolean;
};

const waitersByRoom = new Map<string, Set<Waiter>>();

function bumpAndNotify(room: string) {
  const v = (versionByRoom.get(room) ?? 0) + 1;
  versionByRoom.set(room, v);
  notifyWaiters(room);
}

function notifyWaiters(room: string) {
  const set = waitersByRoom.get(room);
  if (!set || set.size === 0) return;
  // Snapshot first — settleWaiter mutates the set.
  const waiters = Array.from(set);
  for (const w of waiters) settleWaiter(w, makeChangedResponse(room));
}

function settleWaiter(w: Waiter, resp: Response) {
  if (w.settled) return;
  w.settled = true;
  clearTimeout(w.timer);
  w.signal.removeEventListener("abort", w.abortHandler);
  const set = waitersByRoom.get(w.room);
  if (set) {
    set.delete(w);
    if (set.size === 0) waitersByRoom.delete(w.room);
  }
  w.resolveRaw(resp);
}

function makeChangedResponse(room: string): Response {
  const state = rooms.get(room) ?? {};
  const v = versionByRoom.get(room) ?? 0;
  return Response.json(
    { status: "changed", etag: `${bootId}:${v}`, version: v, state },
    { headers: CORS },
  );
}

function makeNotModifiedResponse(room: string): Response {
  const v = versionByRoom.get(room) ?? 0;
  return Response.json(
    { status: "not_modified", etag: `${bootId}:${v}`, version: v },
    { headers: CORS },
  );
}

async function makeResetResponse(room: string): Promise<Response> {
  const state = await loadRoom(room);
  return Response.json(
    { status: "reset", etag: `${bootId}:0`, version: 0, state },
    { headers: CORS },
  );
}

function parseWaitParam(s: string | null): number {
  if (!s) return 0;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.floor(n), MAX_WAIT_SEC);
}

async function longPoll(
  req: Request,
  room: string,
  waitSec: number,
  since: string | null,
): Promise<Response> {
  const currentVer = versionByRoom.get(room) ?? 0;

  if (!since) return makeResetResponse(room);
  const colon = since.indexOf(":");
  if (colon <= 0) return makeResetResponse(room);
  const sinceBootId = since.slice(0, colon);
  const sinceVer = Number(since.slice(colon + 1));
  if (
    sinceBootId !== bootId ||
    !Number.isFinite(sinceVer) ||
    sinceVer < 0 ||
    sinceVer > currentVer
  ) {
    return makeResetResponse(room);
  }

  if (sinceVer < currentVer) return makeChangedResponse(room);

  // sinceVer === currentVer → wait for the next change or timeout.
  return new Promise<Response>((resolveRaw) => {
    const signal = req.signal;
    const w: Waiter = {
      resolveRaw,
      timer: undefined as unknown as ReturnType<typeof setTimeout>,
      signal,
      abortHandler: undefined as unknown as () => void,
      room,
      settled: false,
    };
    w.timer = setTimeout(
      () => settleWaiter(w, makeNotModifiedResponse(room)),
      waitSec * 1000,
    );
    w.abortHandler = () => settleWaiter(w, makeNotModifiedResponse(room));
    signal.addEventListener("abort", w.abortHandler);
    let set = waitersByRoom.get(room);
    if (!set) {
      set = new Set();
      waitersByRoom.set(room, set);
    }
    set.add(w);
  });
}

const server = Bun.serve({
  port: PORT,

  async fetch(req, srv) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/ws") {
      const ok = srv.upgrade(req, {
        data: { peer: { id: crypto.randomUUID(), room: "", user: null } } satisfies WsData,
      });
      return ok ? undefined : new Response("upgrade failed", { status: 400 });
    }

    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

    if (path === "/" || path === "/index.html") {
      return (
        (await serveStatic(PUBLIC_DIR, "index.html", "text/html; charset=utf-8")) ??
        new Response(landingHtml(), { headers: { ...CORS, "Content-Type": "text/html; charset=utf-8" } })
      );
    }

    if (path === "/sync.js") {
      return (
        (await serveStatic(PUBLIC_DIR, "sync.js", "application/javascript; charset=utf-8")) ??
        new Response("// sync.js not found", { status: 404, headers: CORS })
      );
    }

    if (path.startsWith("/examples/")) {
      const name = path.slice("/examples/".length);
      const ext = name.split(".").pop()?.toLowerCase();
      const ct =
        ext === "html"
          ? "text/html; charset=utf-8"
          : ext === "js"
            ? "application/javascript; charset=utf-8"
            : ext === "css"
              ? "text/css; charset=utf-8"
              : undefined;
      const res = await serveStatic(EXAMPLES_DIR, name, ct);
      if (res) return res;
    }

    // ---- Skill distribution ----
    // /install              → one-liner bash script (curl ... | sh)
    // /skill/<file>         → raw skill source files (SKILL.md, evals/evals.json, ...)
    if (path === "/install" && req.method === "GET") {
      const base = `${url.protocol}//${url.host}`;
      const script = `#!/bin/sh
# livehtml-skill installer — fetches SKILL.md into ~/.claude/skills/livehtml
set -e
DEST="\${HTML_SYNC_SKILL_DEST:-$HOME/.claude/skills/livehtml}"
mkdir -p "$DEST"
echo "→ Installing livehtml skill to $DEST"
curl -fsSL ${base}/skill/SKILL.md -o "$DEST/SKILL.md"
echo "✓ Done. Restart Claude Code (or reload) to pick up the skill."
echo "  Verify: ls $DEST/SKILL.md"
`;
      return new Response(script, {
        headers: { ...CORS, "Content-Type": "text/x-shellscript; charset=utf-8" },
      });
    }

    if (path.startsWith("/skill/")) {
      const name = path.slice("/skill/".length);
      if (name.includes("..")) return errResp("not found", 404);
      const filePath = join(SKILL_DIR, name);
      if (!existsSync(filePath)) return errResp("not found", 404);
      const ext = name.split(".").pop()?.toLowerCase();
      const ct =
        ext === "md"
          ? "text/markdown; charset=utf-8"
          : ext === "json"
            ? "application/json; charset=utf-8"
            : "text/plain; charset=utf-8";
      // Substitute LIVEHTML_BASE_URL with the actual base the client hit,
      // so agents that install via `curl <host>/install | sh` get a SKILL.md
      // that points at their deployment (not at the upstream repo's IP).
      const base = `${url.protocol}//${url.host}`;
      const content = (await readFile(filePath, "utf8"))
        .replaceAll("LIVEHTML_BASE_URL", base);
      return new Response(content, { headers: { ...CORS, "Content-Type": ct } });
    }

    if (path === "/rooms" && req.method === "GET") {
      const allRooms = new Set([...rooms.keys(), ...peersByRoom.keys()]);
      const out = Array.from(allRooms).map((room) => ({
        room,
        peers: peersByRoom.get(room)?.size ?? 0,
        keys: Object.keys(rooms.get(room) ?? {}).length,
      }));
      return Response.json(out, { headers: CORS });
    }

    // ---- /pages: HTML hosting backed by MinIO ----

    if (path === "/pages" || path === "/pages/") {
      if (!minio) return errResp("minio not configured", 503);
      if (req.method !== "GET") return errResp("method not allowed", 405);
      const items: { key: string; size: number; lastModified: string; url: string }[] = [];
      const stream = minio.listObjectsV2(MINIO_BUCKET, "", true);
      for await (const obj of stream) {
        if (!obj.name) continue;
        items.push({
          key: obj.name,
          size: obj.size ?? 0,
          lastModified: obj.lastModified?.toISOString?.() ?? "",
          url: `/pages/${obj.name}`,
        });
      }
      return jsonResp(items);
    }

    if (path.startsWith("/pages/")) {
      const rest = path.slice("/pages/".length);

      // /pages/<key>/state — alias for /state/pages/<key>, no MinIO needed.
      // GET with ?wait=<sec> opts into long-poll envelope; otherwise plain.
      if (rest.endsWith("/state")) {
        const rawKey = rest.slice(0, -"/state".length);
        const key = sanitizePageKey(rawKey);
        if (!key) return errResp("invalid key", 400);
        const room = roomForPageKey(key);
        if (req.method === "GET") {
          const waitSec = parseWaitParam(url.searchParams.get("wait"));
          if (waitSec > 0) {
            return await longPoll(req, room, waitSec, url.searchParams.get("since"));
          }
        }
        const resp = await handleStateRoom(req, room);
        if (resp) return resp;
        return errResp("method not allowed", 405);
      }

      if (!minio) return errResp("minio not configured", 503);
      const key = sanitizePageKey(rest);
      if (!key) return errResp("invalid key", 400);

      if (req.method === "PUT") {
        const body = await readBodyToBuffer(req);
        if (!body) return errResp(`body must be non-empty and ≤ ${MAX_HTML_SIZE} bytes`, 400);
        await minio.putObject(MINIO_BUCKET, key, body, body.length, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache",
        });
        return jsonResp({ ok: true, key, url: `/pages/${key}`, room: roomForPageKey(key) });
      }

      if (req.method === "GET") {
        try {
          const data = await streamMinioObject(key);
          return new Response(data, {
            headers: {
              ...CORS,
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "no-cache",
            },
          });
        } catch (e: any) {
          if (e?.code === "NoSuchKey" || e?.code === "NotFound") return errResp("not found", 404);
          console.error("[pages] get error:", e);
          return errResp("internal error", 500);
        }
      }

      if (req.method === "DELETE") {
        try {
          await minio.removeObject(MINIO_BUCKET, key);
        } catch (e: any) {
          if (!(e?.code === "NoSuchKey" || e?.code === "NotFound")) {
            console.error("[pages] delete error:", e);
            return errResp("internal error", 500);
          }
        }
        const room = roomForPageKey(key);
        rooms.delete(room);
        metaByRoom.delete(room);
        try { await unlink(roomFile(room)); } catch {}
        broadcast(room, { t: "replace", state: {}, by: "delete" });
        bumpAndNotify(room);
        return jsonResp({ ok: true, key, room });
      }

      return errResp("method not allowed", 405);
    }

    if (path.startsWith("/state/")) {
      const raw = decodeURIComponent(path.slice("/state/".length));
      const room = sanitizeRoom(raw);
      const resp = await handleStateRoom(req, room);
      if (resp) return resp;
    }

    return new Response("not found", { status: 404, headers: CORS });
  },

  websocket: {
    async message(ws, message) {
      let msg: any;
      try {
        msg = JSON.parse(message.toString());
      } catch {
        return;
      }
      const peer = ws.data.peer;

      if (msg.t === "hi") {
        const room = sanitizeRoom(msg.room || "default");
        peer.room = room;
        peer.user = msg.user ?? null;
        if (typeof msg.clientId === "string" && msg.clientId.length <= 64) {
          peer.id = msg.clientId;
        }
        const set = peersByRoom.get(room) ?? new Set<ServerWebSocket<WsData>>();
        set.add(ws);
        peersByRoom.set(room, set);
        const state = await loadRoom(room);
        ws.send(
          JSON.stringify({
            t: "init",
            room,
            state,
            peers: presenceList(room),
            you: peer.id,
          }),
        );
        broadcast(room, { t: "pres", peers: presenceList(room) }, ws);
        return;
      }

      if (!peer.room) return;

      if (msg.t === "set" && typeof msg.key === "string") {
        const state = await loadRoom(peer.room);
        state[msg.key] = msg.v;
        setKeyMeta(peer.room, msg.key, peer.id);
        scheduleSave(peer.room);
        broadcast(peer.room, { t: "set", key: msg.key, v: msg.v, by: peer.id }, ws);
        bumpAndNotify(peer.room);
        return;
      }

      if (msg.t === "del" && typeof msg.key === "string") {
        const state = await loadRoom(peer.room);
        delete state[msg.key];
        delKeyMeta(peer.room, msg.key);
        scheduleSave(peer.room);
        broadcast(peer.room, { t: "del", key: msg.key, by: peer.id }, ws);
        bumpAndNotify(peer.room);
        return;
      }

      if (msg.t === "pres") {
        peer.user = msg.v ?? null;
        broadcast(peer.room, { t: "pres", peers: presenceList(peer.room) });
        return;
      }
    },

    close(ws) {
      const peer = ws.data.peer;
      if (!peer.room) return;
      const set = peersByRoom.get(peer.room);
      if (!set) return;
      set.delete(ws);
      if (set.size === 0) peersByRoom.delete(peer.room);
      else broadcast(peer.room, { t: "pres", peers: presenceList(peer.room) });
    },
  },
});

function landingHtml() {
  return `<!doctype html>
<html lang="zh">
<head><meta charset="utf-8"><title>livehtml</title>
<style>body{font:14px/1.6 -apple-system,sans-serif;max-width:760px;margin:40px auto;padding:0 20px;color:#222}
code{background:#f4f4f5;padding:2px 6px;border-radius:4px;font-size:13px}
pre{background:#1e1e2e;color:#cdd6f4;padding:14px 18px;border-radius:8px;overflow:auto;font-size:13px}
a{color:#2563eb}</style></head>
<body>
<h1>livehtml</h1>
<p>给 agent 生成的 HTML 加多人协作状态。Server 运行在 <code>http://localhost:${PORT}</code>。</p>
<h2>用法</h2>
<pre>&lt;input type="checkbox" data-live="task-1"&gt; 任务一
&lt;input type="text" data-live="note" placeholder="备注"&gt;
&lt;details data-live="section"&gt;&lt;summary&gt;展开&lt;/summary&gt;内容&lt;/details&gt;

&lt;script src="http://localhost:${PORT}/sync.js"&gt;&lt;/script&gt;</pre>
<h2>HTML 托管（MinIO 后端）</h2>
<ul>
  <li><code>PUT /pages/&lt;key&gt;</code> — body 是 HTML，上传到 MinIO，room id 自动 = <code>pages/&lt;key&gt;</code></li>
  <li><code>GET /pages/&lt;key&gt;</code> — 从 MinIO 取回 HTML 给浏览器</li>
  <li><code>DELETE /pages/&lt;key&gt;</code> — 删除 HTML 同时清掉 room 状态</li>
  <li><code>GET /pages/</code> — 列出所有 HTML key</li>
</ul>
<h2>状态 API</h2>
<ul>
  <li><code>GET /sync.js</code> — 客户端脚本</li>
  <li><code>WS  /ws</code> — WebSocket 同步通道</li>
  <li><code>GET /state/&lt;room&gt;</code> — 读取房间状态 (JSON)</li>
  <li><code>PUT /state/&lt;room&gt;</code> — 整体覆盖房间状态</li>
  <li><code>DELETE /state/&lt;room&gt;</code> — 清空房间</li>
  <li><code>GET /rooms</code> — 列出所有房间及在线人数</li>
</ul>
<p>HTML 通过 <code>/pages/&lt;key&gt;</code> 访问时，<code>sync.js</code> 自动用 <code>location.pathname</code> 推导 room id（无需 <code>&lt;meta&gt;</code>）。</p>
</body></html>`;
}

console.log(`livehtml listening on http://localhost:${server.port}`);
console.log(`  state dir: ${STATE_DIR}`);
