#!/usr/bin/env bun
// livehtml login — dws-style loopback DingTalk login that caches a per-user
// API token at ~/.local/state/livehtml/api-token (mode 600) and silently
// refreshes when possible. Run with Bun: `bun livehtml-login.ts`.
import http from "node:http";
import { spawn } from "node:child_process";
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
    fs.chmodSync(p, 0o600); // {mode} only applies on create; chmod covers a pre-existing file
  } catch {}
}

function arg(name: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] ?? "" : "";
}

const BASE = (arg("--base") || process.env.LIVEHTML_BASE_URL || readState("base-url")).replace(/\/+$/, "");
if (!BASE) {
  console.error("✗ no base url. Pass --base <url>, set LIVEHTML_BASE_URL, or install the skill first.");
  process.exit(1);
}

interface TokenResp {
  token: string;
  name: string;
  exp: number | string;
}

function tokenExp(tok: string): number {
  try {
    const p = tok.split(".")[0]!.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(p, "base64").toString("utf8")).exp || 0;
  } catch {
    return 0;
  }
}

async function postRefresh(cur: string): Promise<TokenResp | null> {
  try {
    const res = await fetch(BASE + "/auth/token/refresh", {
      method: "POST",
      headers: { Authorization: "Bearer " + cur },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    return (await res.json()) as TokenResp;
  } catch {
    return null;
  }
}

function openBrowser(u: string): void {
  const plat = process.platform;
  const cmd = plat === "darwin" ? "open" : plat === "win32" ? "cmd" : "xdg-open";
  const args = plat === "win32" ? ["/c", "start", "", u] : [u];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    /* the printed URL is the fallback */
  }
}

function loopbackLogin(): Promise<TokenResp> {
  return new Promise<TokenResp>((resolve, reject) => {
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
      const got: TokenResp = {
        token: u.searchParams.get("token") ?? "",
        name: u.searchParams.get("name") ?? "",
        exp: u.searchParams.get("exp") ?? "",
      };
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", Connection: "close" });
      res.end(
        "<!doctype html><meta charset=utf-8><body style='font:16px sans-serif;text-align:center;margin-top:80px'>✓ 登录成功，可以关闭这个标签页。</body>",
      );
      got.token ? finish(resolve, got) : finish(reject, new Error("no token received"));
    });
    timer = setTimeout(() => finish(reject, new Error("timed out waiting for login (120s)")), 120000);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const cb = `http://127.0.0.1:${port}/cb`;
      const next = `/auth/token?cli=${encodeURIComponent(cb)}&n=${nonce}`;
      const loginUrl = `${BASE}/auth/dingtalk/login?next=${encodeURIComponent(next)}`;
      console.log("→ 打开浏览器完成钉钉扫码登录（若没自动打开，手动访问）：\n  " + loginUrl);
      openBrowser(loginUrl);
    });
  });
}

const now = Math.floor(Date.now() / 1000);
const cur = readState("api-token");
if (cur) {
  const exp = tokenExp(cur);
  if (exp - now > 7 * 86400) {
    console.log("✓ 已登录（token 仍有效）。");
    process.exit(0);
  }
  if (exp > now) {
    const r = await postRefresh(cur);
    if (r && r.token) {
      writeState("api-token", r.token);
      console.log(`✓ 已静默续期：${r.name}`);
      process.exit(0);
    }
  }
}

try {
  const r = await loopbackLogin();
  writeState("api-token", r.token);
  const when = r.exp ? new Date(Number(r.exp) * 1000).toLocaleString("zh-CN") : "";
  console.log(`✓ 已登录：${r.name}${when ? "（" + when + " 过期）" : ""}\n  token → ${path.join(STATE_DIR, "api-token")}`);
} catch (e: any) {
  console.error("✗ 登录失败：" + (e?.message ?? e));
  process.exit(1);
}
