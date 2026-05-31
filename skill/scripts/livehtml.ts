#!/usr/bin/env bun
// livehtml — CLI for the livehtml service.
// Auto-loads the base URL + per-user API token from ~/.local/state/livehtml/ —
// no env vars, no manual `Authorization` headers, token auto-refreshed.
// Run `livehtml help` for usage. Requires Bun.
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STATE_DIR = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local/state"), "livehtml");

function readState(f: string): string {
  try {
    return fs.readFileSync(path.join(STATE_DIR, f), "utf8").trim();
  } catch {
    return "";
  }
}
function writeState(f: string, v: string): void {
  const p = path.join(STATE_DIR, f);
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(p, v, { mode: 0o600 });
  try {
    fs.chmodSync(p, 0o600);
  } catch {}
}

const argv = process.argv.slice(2);
const cmd = argv[0] || "help";
const BOOL_FLAGS = new Set(["--public"]);

function flag(name: string): boolean {
  return argv.includes(name);
}
function optv(name: string): string {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] ?? "" : "";
}
// Positional args (skip the command + any --flags and their values).
function positionals(): string[] {
  const out: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      if (!BOOL_FLAGS.has(a)) i++; // consume the flag's value
      continue;
    }
    out.push(a);
  }
  return out;
}

const BASE = (optv("--base") || process.env.LIVEHTML_BASE_URL || readState("base-url")).replace(/\/+$/, "");

// Proxy bypass for private/LAN hosts. Bun's fetch reads the proxy env at startup
// and ignores NO_PROXY, so a LAN livehtml server (the common case) would hang via
// an internet proxy. When a proxy is set and the host is private, re-exec this
// process once with the proxy env stripped so fetch goes direct.
function isPrivateHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".local")) return true;
  const m = host.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}
const NET_CMDS = new Set(["login", "put", "get", "set", "watch", "ls", "list", "rm", "del", "delete"]);
const PROXY_KEYS = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"];
if (NET_CMDS.has(cmd) && BASE && !process.env.LIVEHTML_NOPROXY_REEXEC && PROXY_KEYS.some((k) => process.env[k])) {
  let host = "";
  try {
    host = new URL(BASE).hostname;
  } catch {}
  if (host && isPrivateHost(host)) {
    const env: Record<string, string> = { ...(process.env as any), LIVEHTML_NOPROXY_REEXEC: "1" };
    for (const k of PROXY_KEYS) delete env[k];
    const r = spawnSync(process.execPath, [import.meta.path, ...argv], { stdio: "inherit", env });
    process.exit(r.status ?? 0);
  }
}

function die(msg: string): never {
  console.error("✗ " + msg);
  process.exit(1);
}
function tokenExp(tok: string): number {
  try {
    const p = tok.split(".")[0]!.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(p, "base64").toString("utf8")).exp || 0;
  } catch {
    return 0;
  }
}
// Refresh the cached token if it's within 7 days of expiry (no browser needed).
async function refreshIfNeeded(): Promise<string> {
  let tok = readState("api-token");
  if (!tok) return "";
  const now = Math.floor(Date.now() / 1000);
  const exp = tokenExp(tok);
  if (exp && exp > now && exp - now < 7 * 86400) {
    try {
      const r = await fetch(BASE + "/auth/token/refresh", { method: "POST", headers: { Authorization: "Bearer " + tok } });
      if (r.ok) {
        const j: any = await r.json();
        if (j.token) {
          writeState("api-token", j.token);
          tok = j.token;
        }
      }
    } catch {}
  }
  return tok;
}

async function api(method: string, p: string, opts: { body?: any; headers?: Record<string, string> } = {}): Promise<Response> {
  if (!BASE) die("no base url — run `livehtml login`, or set ~/.local/state/livehtml/base-url (or pass --base).");
  const tok = await refreshIfNeeded();
  const headers: Record<string, string> = { ...(opts.headers || {}) };
  if (tok) headers.Authorization = "Bearer " + tok;
  const res = await fetch(BASE + p, { method, headers, body: opts.body, signal: AbortSignal.timeout(70000) });
  if (res.status === 401) die("unauthorized — run `livehtml login` to get a token.");
  return res;
}

function encKey(k: string): string {
  return k.split("/").map(encodeURIComponent).join("/"); // keep hierarchical slashes
}
function readInput(file: string): Buffer {
  return file === "-" ? fs.readFileSync(0) : fs.readFileSync(file); // "-" = stdin
}
async function printResp(res: Response): Promise<void> {
  const t = await res.text();
  try {
    console.log(JSON.stringify(JSON.parse(t), null, 2));
  } catch {
    console.log(t);
  }
}

// ---- login (loopback) ----
function openBrowser(u: string): void {
  const plat = process.platform;
  const c = plat === "darwin" ? "open" : plat === "win32" ? "cmd" : "xdg-open";
  const a = plat === "win32" ? ["/c", "start", "", u] : [u];
  try {
    spawn(c, a, { stdio: "ignore", detached: true }).unref();
  } catch {}
}
function loopbackLogin(): Promise<{ token: string; name: string; exp: string }> {
  return new Promise((resolve, reject) => {
    const nonce = randomBytes(16).toString("hex");
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (fn: (a: any) => void, a: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        server.close();
      } catch {}
      fn(a);
    };
    const server = http.createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://127.0.0.1");
      if (u.pathname !== "/cb") {
        res.writeHead(404);
        res.end();
        return;
      }
      if (u.searchParams.get("n") !== nonce) {
        res.writeHead(400);
        res.end("bad nonce");
        return;
      }
      const got = { token: u.searchParams.get("token") ?? "", name: u.searchParams.get("name") ?? "", exp: u.searchParams.get("exp") ?? "" };
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", Connection: "close" });
      res.end("<!doctype html><meta charset=utf-8><body style='font:16px sans-serif;text-align:center;margin-top:80px'>✓ 登录成功，可以关闭这个标签页。</body>");
      got.token ? finish(resolve, got) : finish(reject, new Error("no token received"));
    });
    timer = setTimeout(() => finish(reject, new Error("timed out waiting for login (120s)")), 120000);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as any).port;
      const cb = `http://127.0.0.1:${port}/cb`;
      const next = `/auth/token?cli=${encodeURIComponent(cb)}&n=${nonce}`;
      const url = `${BASE}/auth/dingtalk/login?next=${encodeURIComponent(next)}`;
      console.log("→ 打开浏览器完成钉钉扫码登录（若没自动打开，手动访问）：\n  " + url);
      openBrowser(url);
    });
  });
}
async function cmdLogin(): Promise<void> {
  if (!BASE) die("no base url — install the skill first, or pass --base <url>.");
  const now = Math.floor(Date.now() / 1000);
  const cur = readState("api-token");
  if (cur) {
    if (tokenExp(cur) - now > 7 * 86400) {
      console.log("✓ 已登录（token 仍有效）。");
      return;
    }
    const t = await refreshIfNeeded();
    if (t && tokenExp(t) - now > 7 * 86400) {
      console.log("✓ 已静默续期。");
      return;
    }
  }
  const r = await loopbackLogin();
  writeState("api-token", r.token);
  const when = r.exp ? new Date(Number(r.exp) * 1000).toLocaleString("zh-CN") : "";
  console.log(`✓ 已登录：${r.name}${when ? "（" + when + " 过期）" : ""}`);
}

function usage(): void {
  console.log(`livehtml — 实时协作 HTML 托管 CLI（自动读取 base-url + token，自动续期）

  livehtml login                        钉钉扫码登录，拿/续期个人 token
  livehtml put <key> <file> [--public]  上传 HTML 页面（--public = 免登浏览）
  livehtml get <key>                    读回该页状态 (JSON)
  livehtml set <key> '<json>'           整体写入该页状态
  livehtml watch <key>                  阻塞至下次有人改动（最多 60s）
  livehtml ls                           列出所有页面
  livehtml rm <key>                     删除页面（连同状态）
  livehtml status                       显示 base-url / 登录状态
  livehtml help                         本帮助

  · <file> 用 - 表示从 stdin 读；<key> 可含 / 做层级（如 aura/report）。
  · base-url 自动取自 ~/.local/state/livehtml/base-url（也可 --base 或 $LIVEHTML_BASE_URL）。
  · 受保护部署先 \`livehtml login\` 一次，之后全部命令自动带凭证。`);
}

try {
  switch (cmd) {
    case "login":
      await cmdLogin();
      break;
    case "put": {
      const [key, file] = positionals();
      if (!key || !file) die("用法: livehtml put <key> <file> [--public]");
      const headers: Record<string, string> = {};
      if (flag("--public")) headers["X-Public"] = "1";
      await printResp(await api("PUT", "/pages/" + encKey(key), { body: readInput(file), headers }));
      break;
    }
    case "get": {
      const [key] = positionals();
      if (!key) die("用法: livehtml get <key>");
      await printResp(await api("GET", "/pages/" + encKey(key) + "/state"));
      break;
    }
    case "set": {
      const [key, json] = positionals();
      if (!key || json == null) die("用法: livehtml set <key> '<json>'");
      await printResp(await api("PUT", "/pages/" + encKey(key) + "/state", { body: json, headers: { "Content-Type": "application/json" } }));
      break;
    }
    case "watch": {
      const [key] = positionals();
      if (!key) die("用法: livehtml watch <key>");
      const wait = optv("--wait") || "60";
      let since = optv("--since");
      if (!since) {
        const boot: any = await (await api("GET", `/pages/${encKey(key)}/state?wait=1&since=`)).json().catch(() => ({}));
        since = boot.etag || "";
      }
      await printResp(await api("GET", `/pages/${encKey(key)}/state?wait=${encodeURIComponent(wait)}&since=${encodeURIComponent(since)}`));
      break;
    }
    case "ls":
    case "list":
      await printResp(await api("GET", "/pages/"));
      break;
    case "rm":
    case "del":
    case "delete": {
      const [key] = positionals();
      if (!key) die("用法: livehtml rm <key>");
      await printResp(await api("DELETE", "/pages/" + encKey(key)));
      break;
    }
    case "status":
    case "whoami": {
      console.log("base-url: " + (BASE || "(未设置)"));
      const tok = readState("api-token");
      if (!tok) {
        console.log("token   : (未登录) — 运行 livehtml login");
        break;
      }
      const exp = tokenExp(tok);
      const now = Math.floor(Date.now() / 1000);
      console.log("token   : 已登录" + (exp ? `（${new Date(exp * 1000).toLocaleString("zh-CN")} 过期，${exp > now ? "有效" : "已过期"}）` : ""));
      break;
    }
    default:
      usage();
      break;
  }
} catch (e: any) {
  die((e && e.message) || String(e));
}
