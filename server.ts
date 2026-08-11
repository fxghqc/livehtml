import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { Client as MinioClient } from "minio";
import { loadAuthConfig } from "./auth/config.ts";
import { createDingTalkClient } from "./auth/dingtalk.ts";
import { handleAuthRoute } from "./auth/routes.ts";
import { readSession, parseCookies, signRoomToken, verifyRoomToken } from "./auth/session.ts";
import { apiTokenOk, humanAllowed, isNavigation, parsePublicMeta, parseReadRooms, roomPublicKey, sanitizeNext } from "./auth/gate.ts";
import { injectSync } from "./inject.ts";
import { createOpsLimiter } from "./limits.ts";
import { lintHtml } from "./lint.ts";

const PORT = Number(process.env.PORT || 8787);
const ROOT = import.meta.dir;
const STATE_DIR = join(ROOT, "state");
const PUBLIC_DIR = join(ROOT, "public");
const EXAMPLES_DIR = join(ROOT, "examples");
const SKILL_DIR = join(ROOT, "skill");
const MAX_HTML_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_WAIT_SEC = 60;

// How long a `~` (live-only) key survives without being rewritten before the
// server reclaims it. `0` = never (keys live until the process does).
const TRANSIENT_TTL_SEC = (() => {
  const n = Number(process.env.TRANSIENT_TTL_SEC ?? 30);
  return Number.isFinite(n) && n >= 0 ? n : 30;
})();
const TRANSIENT_SWEEP_MS = 1000;

// Upstream guardrails. One op is fanned out to every peer in the room, stamped,
// and (unless transient) debounced to disk — so both its size and its rate are
// everyone else's problem, not just the writer's.
const OPS_MAX_BYTES = (() => {
  const n = Number(process.env.OPS_MAX_BYTES ?? 262144);
  return Number.isFinite(n) && n > 0 ? n : 262144;
})();
// `0` turns rate limiting off. Ordinary collaboration pages (checkboxes, forms,
// votes) sit orders of magnitude below this; a page that writes per animation
// frame does not, and is meant to feel it.
const OPS_RATE_PER_SEC = (() => {
  const n = Number(process.env.OPS_RATE_PER_SEC ?? 60);
  return Number.isFinite(n) && n >= 0 ? n : 60;
})();

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
  // Ensure the bucket in the background with capped-backoff retries. At boot
  // MinIO may not be accepting connections yet (e.g. both containers restarting
  // together after a host outage) — a transient failure must NOT permanently
  // disable storage, so the client is never nulled here. `minio === null` means
  // exactly "MINIO_ENDPOINT unset".
  void (async () => {
    for (let delay = 1000; ; delay = Math.min(delay * 2, 30_000)) {
      try {
        if (!(await minio!.bucketExists(MINIO_BUCKET))) {
          await minio!.makeBucket(MINIO_BUCKET);
          console.log(`[minio] created bucket "${MINIO_BUCKET}"`);
        }
        console.log(`[minio] connected to ${MINIO_ENDPOINT}, bucket="${MINIO_BUCKET}"`);
        return;
      } catch (e) {
        console.error(`[minio] init failed (retry in ${delay / 1000}s):`, (e as Error)?.message ?? e);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  })();
}

// ---- Auth (optional; both gates off => unchanged behavior) ----
const authCfg = loadAuthConfig(process.env as Record<string, string | undefined>);
const ding = authCfg.dingtalkEnabled
  ? createDingTalkClient({ clientId: authCfg.clientId, clientSecret: authCfg.clientSecret, corpId: authCfg.corpId })
  : null;
const nowSec = () => Math.floor(Date.now() / 1000);
if (authCfg.dingtalkEnabled) console.log(`[auth] DingTalk login gate ENABLED`);
if (authCfg.apiTokenEnabled) console.log(`[auth] API token gate ENABLED`);

// Per-page publish-time flags cache (source of truth = MinIO object metadata).
type PageMeta = { isPublic: boolean; readRooms: string[] };
const NO_PAGE_META: PageMeta = { isPublic: false, readRooms: [] };
const pageMetaCache = new Map<string, PageMeta>();
async function pageMeta(key: string): Promise<PageMeta> {
  if (!minio) return NO_PAGE_META;
  const cached = pageMetaCache.get(key);
  if (cached) return cached;
  try {
    const st: any = await minio.statObject(MINIO_BUCKET, key);
    const meta: PageMeta = {
      isPublic: parsePublicMeta(st?.metaData),
      readRooms: parseReadRooms(st?.metaData),
    };
    pageMetaCache.set(key, meta);
    return meta;
  } catch {
    return NO_PAGE_META;
  }
}
async function isPublicPage(key: string): Promise<boolean> {
  return (await pageMeta(key)).isPublic;
}
function apiAuth(req: Request): { ok: boolean; uid?: string; resp?: Response } {
  const gateActive = authCfg.dingtalkEnabled || authCfg.apiTokenEnabled;
  if (!gateActive) return { ok: true };
  const r = apiTokenOk(req, authCfg.apiToken, authCfg.sessionSecret, nowSec());
  if (r.ok) return { ok: true, uid: r.uid };
  return { ok: false, resp: new Response("unauthorized", { status: 401, headers: { ...CORS, "WWW-Authenticate": "Bearer" } }) };
}

type RoomState = Record<string, unknown>;
type Peer = {
  id: string;
  room: string;
  user: unknown;
  auth: { uid: string; name: string } | null;
  // The connection presented a valid API bearer at upgrade — a non-browser
  // client (agent CLI, custom client), which has no page GET to be handed a
  // room token by and so is exempt from the room binding.
  api: boolean;
  // Per-connection id fixed at upgrade. `id` is the client-chosen correlation
  // id and can be anything the page says, so it can never be a rate-limit key:
  // a runaway page would just rotate it. This one the client cannot touch.
  conn: string;
};
type WsData = { peer: Peer };

const rooms = new Map<string, RoomState>();
const writeTimers = new Map<string, ReturnType<typeof setTimeout>>();
const writeChains = new Map<string, Promise<void>>();
const peersByRoom = new Map<string, Set<ServerWebSocket<WsData>>>();
// Read-only cross-room subscribers: a page that declared `--read <room>` at
// publish time is attached here for each declared room. They receive that
// room's frames wrapped in `{t:"room", room, msg}` (the page multiplexes on
// `room`), never appear in its presence, and cannot write to it — `set`/`del`
// only ever touch `peer.room`, so there is no write path to reject.
const readersByRoom = new Map<string, Set<ServerWebSocket<WsData>>>();
const opsLimiter = createOpsLimiter();

// Phase C — per-key metadata kept parallel to `rooms` (flat). Disk
// envelope: { version: 2, fields: { key: { v, ts, by } } }. Format
// detection uses the top-level `version` field only, never field shape.
type FieldMeta = { ts: string; by: string };
const metaByRoom = new Map<string, Record<string, FieldMeta>>();

// Two key prefixes are special, and they are orthogonal.
//
// `~` = live-only. The key broadcasts and sits in room memory like any other,
// but it never reaches the persisted envelope and never moves the version
// counter — so it produces no new etag and does not wake a parked `?wait=`
// long-poll. For cursors, typing hints, high-frequency snapshots: anything
// whose value is worthless a second later and whose write rate would otherwise
// thrash the debounced disk write and the agent's change loop.
function isTransientKey(key: string): boolean {
  return key.startsWith("~");
}

// `__` = server-owned (`__users`). Browser writers may not set or delete one;
// otherwise an ordinary persisted key.
function isReservedKey(key: string): boolean {
  return key.startsWith("__");
}

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
        if (isTransientKey(k)) continue;
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

// ---- Transient (`~`) key reclamation ----

let transientSweepTimer: ReturnType<typeof setInterval> | null = null;

// Eviction goes out as an ordinary `del`, with two markers on the frame: no
// author (`by: ""` — a participant's `by` is a clientId or a verified uid, so
// it is never empty) plus `src: "server"`, which lets a page that filters `del`
// frames by author tell a reclaim apart from a peer's delete. Deliberately no
// scheduleSave (the key was never in the envelope) and no bumpAndNotify (a
// parked long-poll must not wake on a transient key, expiring or not).
function sweepTransientKeys(): void {
  if (TRANSIENT_TTL_SEC <= 0) return;
  const nowMs = Date.now();
  const ttlMs = TRANSIENT_TTL_SEC * 1000;
  for (const [room, state] of rooms) {
    const meta = metaByRoom.get(room);
    for (const key of Object.keys(state)) {
      if (!isTransientKey(key)) continue;
      const ts = Date.parse(meta?.[key]?.ts ?? "");
      // A missing or unparseable stamp counts as expired: erring toward
      // eviction is the direction that cannot leak, and a live writer
      // re-stamps its key within one write anyway.
      if (Number.isFinite(ts) && nowMs - ts <= ttlMs) continue;
      delete state[key];
      if (meta) delete meta[key];
      broadcast(room, { t: "del", key, by: "", src: "server" });
    }
  }
}

// Armed by the paths that can put a `~` key into memory, so a server that never
// sees one never runs the timer. loadRoom can't introduce one (they are filtered
// out of the envelope), so those paths are exhaustive.
function ensureTransientSweep(): void {
  if (transientSweepTimer || TRANSIENT_TTL_SEC <= 0) return;
  transientSweepTimer = setInterval(sweepTransientKeys, TRANSIENT_SWEEP_MS);
  if (typeof transientSweepTimer.unref === "function") transientSweepTimer.unref();
}

function presenceList(room: string) {
  const set = peersByRoom.get(room);
  if (!set) return [];
  return Array.from(set).map((ws) => ({ id: ws.data.peer.id, user: ws.data.peer.user }));
}

function broadcast(room: string, msg: unknown, except?: ServerWebSocket<WsData>) {
  const set = peersByRoom.get(room);
  if (set) {
    const payload = JSON.stringify(msg);
    for (const ws of set) if (ws !== except) ws.send(payload);
  }
  const readers = readersByRoom.get(room);
  if (readers) {
    const wrapped = JSON.stringify({ t: "room", room, msg });
    for (const ws of readers) if (ws !== except) ws.send(wrapped);
  }
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

const MAX_READ_ROOMS = 16;

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

// Server-owned roster {uid: name}, kept in the reserved `__users` key so a page
// can put a name on a participant who has already left — `presenceList` only
// knows live connections. Only authenticated peers are recorded: an anonymous
// peer's id and name are both self-declared, and on a public page the roster
// would then grow once per visit rather than once per person.
async function upsertRoomUser(room: string, uid: string, name: string): Promise<void> {
  const state = await loadRoom(room);
  const cur = state["__users"];
  const users =
    cur && typeof cur === "object" && !Array.isArray(cur)
      ? (cur as Record<string, unknown>)
      : {};
  if (users[uid] === name) return; // reconnects must not broadcast
  state["__users"] = { ...users, [uid]: name };
  setKeyMeta(room, "__users", "system");
  scheduleSave(room);
  broadcast(room, { t: "set", key: "__users", v: state["__users"], by: "system" });
  bumpAndNotify(room);
}

// Replace a room's whole state (HTTP PUT / DELETE). `__users` is server-owned,
// so a caller can neither set it nor drop it: it is stripped from the incoming
// body and the current value carried over. Loading first matters — a cold room
// would otherwise lose the roster still sitting on disk.
async function replaceRoomState(room: string, next: RoomState, by: string): Promise<void> {
  const cur = (await loadRoom(room))["__users"];
  const state: RoomState = { ...next };
  delete state["__users"];
  if (cur !== undefined) state["__users"] = cur;
  rooms.set(room, state);
  replaceRoomMeta(room, Object.keys(state), by);
  if (Object.keys(state).some(isTransientKey)) ensureTransientSweep();
  scheduleSave(room);
  broadcast(room, { t: "replace", state, by });
  bumpAndNotify(room);
}

async function handleStateRoom(req: Request, room: string, by = "http"): Promise<Response | null> {
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
    await replaceRoomState(room, body as RoomState, by);
    return Response.json({ ok: true, room }, { headers: CORS });
  }
  if (req.method === "DELETE") {
    await replaceRoomState(room, {}, by);
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

const server = Bun.serve<WsData, string>({
  port: PORT,

  async fetch(req, srv) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/ws") {
      const sess = authCfg.dingtalkEnabled ? readSession(req, authCfg.sessionSecret, nowSec()) : null;
      const conn = crypto.randomUUID();
      const ok = srv.upgrade(req, {
        data: {
          peer: {
            id: conn,
            conn,
            room: "",
            user: null,
            auth: sess ? { uid: sess.uid, name: sess.name } : null,
            api: apiTokenOk(req, authCfg.apiToken, authCfg.sessionSecret, nowSec()).ok,
          },
        } satisfies WsData,
      });
      return ok ? undefined : new Response("upgrade failed", { status: 400 });
    }

    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

    if (path.startsWith("/auth/")) {
      const r = await handleAuthRoute(req, url, authCfg, ding, nowSec());
      if (r) return r;
    }

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
    // /install              → POSIX installer  (curl -fsSL <url>/install | sh)
    // /install.ps1          → Windows installer (irm <url>/install.ps1 | iex)
    // /skill/<file>         → raw skill source files (SKILL.md, evals/evals.json, ...)
    //
    // Both installers drop the skill bundle (SKILL.md + scripts/livehtml.ts)
    // into every detected agent's global skills dir (Claude Code / Codex / Cursor
    // — paths per the `skills` ecosystem), falling back to Claude Code if none is
    // detected. Runtime config (base-url + optional api-token) goes to
    // <XDG_STATE_HOME|~/.local/state>/livehtml/, which the skill scripts auto-load.
    if (path === "/install" && req.method === "GET") {
      const base = `${url.protocol}//${url.host}`;
      const script = `#!/bin/sh
# livehtml-skill installer — installs SKILL.md into your agent(s) + saves the base URL
set -e
BASE="${base}"
SKILL="livehtml"

# Config/state dir holds ONLY runtime config the skill scripts auto-load:
# base-url (+ optional api-token). The skill CODE (incl. the login CLI) is
# bundled into the skill dir below — not here.
STATE_DIR="\${XDG_STATE_HOME:-$HOME/.local/state}/livehtml"
mkdir -p "$STATE_DIR"
printf '%s' "$BASE" > "$STATE_DIR/base-url"
echo "✓ base URL → $STATE_DIR/base-url"

if [ -n "\${LIVEHTML_API_TOKEN:-}" ]; then
  printf '%s' "$LIVEHTML_API_TOKEN" > "$STATE_DIR/api-token"
  chmod 600 "$STATE_DIR/api-token" 2>/dev/null || true
  echo "✓ api token → $STATE_DIR/api-token"
fi

CLAUDE_DIR="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
CODEX_DIR="\${CODEX_HOME:-$HOME/.codex}"
CURSOR_DIR="$HOME/.cursor"

n=0
install_to() {
  # \$1 display name  \$2 agent home  \$3 skills root
  [ -d "$2" ] || return 0
  dest="$3/$SKILL"
  mkdir -p "$dest/scripts"
  curl -fsSL "$BASE/skill/SKILL.md" -o "$dest/SKILL.md"
  curl -fsSL "$BASE/skill/scripts/livehtml.ts" -o "$dest/scripts/livehtml.ts" 2>/dev/null || true
  echo "✓ $1 → $dest (SKILL.md + scripts/livehtml.ts)"
  n=$((n + 1))
}

install_to "Claude Code" "$CLAUDE_DIR" "$CLAUDE_DIR/skills"
install_to "Codex"       "$CODEX_DIR"  "$CODEX_DIR/skills"
install_to "Cursor"      "$CURSOR_DIR" "$CURSOR_DIR/skills"

if [ "$n" -eq 0 ]; then
  dest="$CLAUDE_DIR/skills/$SKILL"
  mkdir -p "$dest/scripts"
  curl -fsSL "$BASE/skill/SKILL.md" -o "$dest/SKILL.md"
  curl -fsSL "$BASE/skill/scripts/livehtml.ts" -o "$dest/scripts/livehtml.ts" 2>/dev/null || true
  echo "✓ no agent detected; installed for Claude Code → $dest"
fi
echo "✓ Done. Restart your agent to pick up the skill."
echo "  Protected deploy? Log in once: bun <skills>/livehtml/scripts/livehtml.ts login"
`;
      return new Response(script, {
        headers: { ...CORS, "Content-Type": "text/x-shellscript; charset=utf-8" },
      });
    }

    if (path === "/install.ps1" && req.method === "GET") {
      const base = `${url.protocol}//${url.host}`;
      const script = `# livehtml-skill installer for Windows — irm ${base}/install.ps1 | iex
$ErrorActionPreference = 'Stop'
$Base = '${base}'
$Skill = 'livehtml'

$StateDir = Join-Path $HOME '.local/state/livehtml'
New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
[System.IO.File]::WriteAllText((Join-Path $StateDir 'base-url'), $Base)
Write-Host "[ok] base URL -> $StateDir/base-url"

if ($env:LIVEHTML_API_TOKEN) {
  [System.IO.File]::WriteAllText((Join-Path $StateDir 'api-token'), $env:LIVEHTML_API_TOKEN)
  Write-Host "[ok] api token -> $StateDir/api-token"
}

$claude = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $HOME '.claude' }
$codex  = if ($env:CODEX_HOME)        { $env:CODEX_HOME }        else { Join-Path $HOME '.codex' }
$cursor = Join-Path $HOME '.cursor'

$targets = @(
  @{ name = 'Claude Code'; home = $claude; skills = (Join-Path $claude 'skills') }
  @{ name = 'Codex';       home = $codex;  skills = (Join-Path $codex  'skills') }
  @{ name = 'Cursor';      home = $cursor; skills = (Join-Path $cursor 'skills') }
)

$md = (Invoke-WebRequest -Uri "$Base/skill/SKILL.md" -UseBasicParsing).Content
$login = $null
try { $login = (Invoke-WebRequest -Uri "$Base/skill/scripts/livehtml.ts" -UseBasicParsing).Content } catch {}
function Install-Skill($dest) {
  New-Item -ItemType Directory -Force -Path (Join-Path $dest 'scripts') | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $dest 'SKILL.md'), $md)
  if ($login) { [System.IO.File]::WriteAllText((Join-Path (Join-Path $dest 'scripts') 'livehtml.ts'), $login) }
}
$n = 0
foreach ($t in $targets) {
  if (Test-Path $t.home) {
    $dest = Join-Path $t.skills $Skill
    Install-Skill $dest
    Write-Host "[ok] $($t.name) -> $dest (SKILL.md + scripts/livehtml.ts)"
    $n++
  }
}
if ($n -eq 0) {
  $dest = Join-Path (Join-Path $claude 'skills') $Skill
  Install-Skill $dest
  Write-Host "[ok] no agent detected; Claude Code -> $dest"
}
Write-Host "Done. Restart your agent. Protected deploy? Run: bun <skills>/livehtml/scripts/livehtml.ts login"
`;
      return new Response(script, {
        headers: { ...CORS, "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    if (path.startsWith("/skill/")) {
      const name = path.slice("/skill/".length);
      const ext = name.split(".").pop()?.toLowerCase();
      const ct =
        ext === "md"
          ? "text/markdown; charset=utf-8"
          : ext === "json"
            ? "application/json; charset=utf-8"
            : "text/plain; charset=utf-8";
      const res = await serveStatic(SKILL_DIR, name, ct);
      if (res) return res;
      return errResp("not found", 404);
    }

    if (path === "/rooms" && req.method === "GET") {
      const a = apiAuth(req); if (!a.ok) return a.resp!;
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
      const a = apiAuth(req); if (!a.ok) return a.resp!;
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
        const a = apiAuth(req); if (!a.ok) return a.resp!;
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
        const resp = await handleStateRoom(req, room, a.uid ?? "http");
        if (resp) return resp;
        return errResp("method not allowed", 405);
      }

      const key = sanitizePageKey(rest);
      if (!key) return errResp("invalid key", 400);

      // DingTalk human gate on the page HTML GET. Runs before MinIO so an
      // unauthenticated visitor is redirected to login even if storage is down.
      if (req.method === "GET" && authCfg.dingtalkEnabled) {
        const isPub = await isPublicPage(key);
        const hasSession = !!readSession(req, authCfg.sessionSecret, nowSec());
        // A bearer already carries PUT/DELETE on every page, so bouncing it to
        // a login page on GET was an inconsistency, not a defence.
        const byBearer = apiTokenOk(req, authCfg.apiToken, authCfg.sessionSecret, nowSec()).ok;
        if (!byBearer && !humanAllowed({ gateOn: true, isPublic: isPub, hasSession })) {
          const loc = `/auth/dingtalk/login?next=${encodeURIComponent(path)}`;
          return new Response(null, { status: 302, headers: { ...CORS, Location: loc } });
        }
        // A protected page's HTML is unlocked by the viewer's cookie, and every
        // published page runs on this same origin — so without this, a fetch()
        // from inside one page would carry that cookie and hand the page the
        // source of every protected page the viewer can see. Cookie access is
        // for people: require a navigation (frames included, so embedding still
        // works). Bearer callers are unaffected, and public pages are excluded
        // because there is nothing there a fetch could learn that a plain GET
        // wouldn't hand out anyway.
        if (!isPub && !byBearer && !isNavigation(req, true)) {
          return errResp("page HTML is served to navigations only", 401);
        }
      }

      // Mutating methods are agent surfaces: token-gate them BEFORE the MinIO
      // availability check so a bad/missing token returns 401, not 503.
      if (req.method === "PUT" || req.method === "DELETE") {
        const a = apiAuth(req); if (!a.ok) return a.resp!;
      }

      if (!minio) return errResp("minio not configured", 503);

      if (req.method === "PUT") {
        const body = await readBodyToBuffer(req);
        if (!body) return errResp(`body must be non-empty and ≤ ${MAX_HTML_SIZE} bytes`, 400);
        const isPub = /^(1|true|yes)$/i.test(req.headers.get("x-public") || "");
        const readRooms = parseReadRooms({ "read-rooms": req.headers.get("x-read-rooms") || "" })
          .map(sanitizeRoom);
        if (readRooms.length > MAX_READ_ROOMS) {
          return errResp(`X-Read-Rooms lists more than ${MAX_READ_ROOMS} rooms`, 400);
        }
        // Publish-time lint. Errors block and come back as data, so an agent
        // reads what is wrong and re-publishes without a human in the loop;
        // X-Skip-Lint is the escape hatch for the day the lint is the one that
        // is wrong.
        const skipLint = /^(1|true|yes)$/i.test(req.headers.get("x-skip-lint") || "");
        const lint = skipLint
          ? { errors: [], warnings: [] }
          : await lintHtml(body.toString("utf8"));
        if (lint.errors.length) {
          return jsonResp({ ok: false, key, errors: lint.errors }, 400);
        }

        const meta: Record<string, string> = {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache",
        };
        if (isPub) meta.public = "1"; // private pages omit the key (spec §10)
        if (readRooms.length) meta["read-rooms"] = readRooms.join(",");
        await minio.putObject(MINIO_BUCKET, key, body, body.length, meta);
        pageMetaCache.set(key, { isPublic: isPub, readRooms });
        const resp: Record<string, unknown> = {
          ok: true,
          key,
          url: `/pages/${key}`,
          room: roomForPageKey(key),
          public: isPub,
        };
        const warnings = [...lint.warnings];
        if (readRooms.length) {
          resp.readRooms = readRooms;
          // Declaring a read opens those rooms to everyone who can open THIS
          // page — including people with no access to the rooms themselves.
          // On a public page that is everyone who can reach the server.
          warnings.push(
            `本页可读 ${readRooms.join("、")} —— 能打开本页的人都能看到这些房间的数据` +
              (isPub ? "，而本页是公开页（免登录）" : ""),
          );
        }
        if (warnings.length) resp.warnings = warnings;
        return jsonResp(resp);
      }

      if (req.method === "GET") {
        try {
          const data = await streamMinioObject(key);
          const room = roomForPageKey(key);
          const { readRooms } = await pageMeta(key);
          // No session secret = no gates configured; the WS asks for no token
          // either, so minting one would be ceremony with nothing to check it.
          const token = authCfg.sessionSecret
            ? signRoomToken(room, readRooms, authCfg.roomTokenTtlSec, authCfg.sessionSecret, nowSec())
            : "";
          return new Response(injectSync(data.toString("utf8"), room, token), {
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
        pageMetaCache.delete(key);
        try { await unlink(roomFile(room)); } catch {}
        broadcast(room, { t: "replace", state: {}, by: "delete" });
        bumpAndNotify(room);
        return jsonResp({ ok: true, key, room });
      }

      return errResp("method not allowed", 405);
    }

    if (path.startsWith("/state/")) {
      const a = apiAuth(req); if (!a.ok) return a.resp!;
      const raw = decodeURIComponent(path.slice("/state/".length));
      const room = sanitizeRoom(raw);
      const resp = await handleStateRoom(req, room, a.uid ?? "http");
      if (resp) return resp;
    }

    return new Response("not found", { status: 404, headers: CORS });
  },

  websocket: {
    async message(ws, message) {
      const raw = message.toString();
      // Checked before parsing: an oversized frame costs a JSON.parse, a fanout
      // to every peer in the room and a disk write, so the cheapest place to
      // refuse it is before any of that.
      if (Buffer.byteLength(raw) > OPS_MAX_BYTES) {
        ws.send(JSON.stringify({ t: "too_large", limit: OPS_MAX_BYTES }));
        return;
      }
      let msg: any;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      const peer = ws.data.peer;

      if (msg.t === "hi") {
        const room = sanitizeRoom(msg.room || "default");

        // Room binding. With the gate on, a browser must present the room token
        // the page GET injected — a capability for THIS room and nothing else,
        // so code running in one page can no longer join another page's room on
        // the strength of the viewer's login. Non-browser clients present an API
        // bearer at upgrade instead. Gate off = no tokens are minted and nothing
        // is asked for, so the open deployment behaves exactly as before.
        let reads: string[] = [];
        if (authCfg.dingtalkEnabled && !peer.api) {
          const rt =
            typeof msg.token === "string"
              ? verifyRoomToken(msg.token, room, authCfg.sessionSecret, nowSec())
              : null;
          if (!rt) {
            ws.send(JSON.stringify({ t: "denied", reason: "room" }));
            ws.close();
            return;
          }
          reads = rt.reads;
        } else {
          // No gate (or an API client): there is no capability to read the
          // declared rooms out of, so they come straight from the page's own
          // publish-time metadata. Nothing is being protected here — with the
          // gate off any client may join any room directly anyway — but
          // `watchRoom` still has to work, and silently doing nothing would be
          // the worst of both.
          const pageKey = roomPublicKey(room);
          if (pageKey) reads = (await pageMeta(pageKey)).readRooms;
        }

        peer.room = room;
        // peer.id stays the client-chosen correlation id — pages key their own
        // state by it (e.g. `vote:<clientId>`) and match it against the presence
        // id. Authentication makes the *name* trustworthy and stamps `by` with the
        // verified uid (see set/del); it does NOT replace the presence id.
        if (typeof msg.clientId === "string" && msg.clientId.length <= 64) {
          peer.id = msg.clientId;
        }
        if (peer.auth) {
          peer.user = { name: peer.auth.name, userId: peer.auth.uid };
        } else {
          peer.user = msg.user ?? null;
        }
        const state = await loadRoom(room);
        // Recorded before this peer joins the broadcast set: the `__users`
        // frame upsert sends is for the peers already here, and this one gets
        // the whole roster in its own `init` below.
        if (peer.auth) await upsertRoomUser(room, peer.auth.uid, peer.auth.name);
        const set = peersByRoom.get(room) ?? new Set<ServerWebSocket<WsData>>();
        set.add(ws);
        peersByRoom.set(room, set);
        ws.send(JSON.stringify({ t: "init", room, state, peers: presenceList(room), you: peer.id }));
        broadcast(room, { t: "pres", peers: presenceList(room) }, ws);
        // Declared read-only rooms are attached here rather than on request:
        // the list is fixed at publish time and baked into the token, so there
        // is nothing for the page to ask for — and a reconnect re-runs `hi`,
        // which restores the subscriptions with no client-side bookkeeping.
        for (const raw of reads) {
          const r = sanitizeRoom(raw);
          if (r === room) continue; // already subscribed as a participant
          const rstate = await loadRoom(r);
          const rset = readersByRoom.get(r) ?? new Set<ServerWebSocket<WsData>>();
          rset.add(ws);
          readersByRoom.set(r, rset);
          ws.send(JSON.stringify({ t: "room", room: r, msg: { t: "init", state: rstate } }));
        }
        return;
      }

      if (!peer.room) return;

      // `by` = the verified uid when authenticated (trustworthy attribution),
      // else the client correlation id. Independent of the presence id.
      const by = peer.auth ? peer.auth.uid : peer.id;

      // Writes are metered per (room, writer); reads, presence and the
      // handshake are not. Keyed on the verified uid when there is one so a
      // person cannot buy more budget by opening tabs, and on the connection
      // otherwise — never on the client-declared id, which is self-chosen.
      if (msg.t === "set" || msg.t === "del") {
        const writer = peer.auth ? "u:" + peer.auth.uid : "c:" + peer.conn;
        const gate = opsLimiter.take(peer.room, writer, OPS_RATE_PER_SEC);
        if (!gate.ok) {
          // The op is dropped, and the key travels with the refusal so the page
          // can re-queue its own current value for that key once the window
          // reopens — re-sending the dropped value would resurrect a value the
          // page may since have superseded.
          ws.send(JSON.stringify({ t: "throttled", key: msg.key, retryAfterMs: gate.retryAfterMs }));
          return;
        }
      }

      if (msg.t === "set" && typeof msg.key === "string") {
        if (isReservedKey(msg.key)) return; // server-owned, browsers can't write
        const state = await loadRoom(peer.room);
        state[msg.key] = msg.v;
        setKeyMeta(peer.room, msg.key, by);
        broadcast(peer.room, { t: "set", key: msg.key, v: msg.v, by }, ws);
        if (isTransientKey(msg.key)) {
          ensureTransientSweep();
          return;
        }
        scheduleSave(peer.room);
        bumpAndNotify(peer.room);
        return;
      }

      if (msg.t === "del" && typeof msg.key === "string") {
        if (isReservedKey(msg.key)) return;
        const state = await loadRoom(peer.room);
        delete state[msg.key];
        delKeyMeta(peer.room, msg.key);
        broadcast(peer.room, { t: "del", key: msg.key, by }, ws);
        if (isTransientKey(msg.key)) return;
        scheduleSave(peer.room);
        bumpAndNotify(peer.room);
        return;
      }

      if (msg.t === "pres") {
        // Trusted identity is server-owned: an authenticated peer cannot rename
        // itself via pres (mirror the `hi` branch). Anonymous peers may self-label.
        if (peer.auth) {
          peer.user = { name: peer.auth.name, userId: peer.auth.uid };
        } else {
          peer.user = msg.v ?? null;
        }
        broadcast(peer.room, { t: "pres", peers: presenceList(peer.room) });
        return;
      }
    },

    close(ws) {
      for (const [room, readers] of readersByRoom) {
        if (readers.delete(ws) && readers.size === 0) readersByRoom.delete(room);
      }
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
