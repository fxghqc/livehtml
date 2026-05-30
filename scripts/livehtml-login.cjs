#!/usr/bin/env node
"use strict";
// livehtml login — dws-style loopback DingTalk login that caches a per-user
// API token at ~/.local/state/livehtml/api-token (mode 600) and silently
// refreshes when possible. Zero npm deps.
const http = require("node:http");
const https = require("node:https");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const STATE_DIR = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local/state"), "livehtml");
const readState = (f) => { try { return fs.readFileSync(path.join(STATE_DIR, f), "utf8").trim(); } catch { return ""; } };
const writeState = (f, v) => { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(path.join(STATE_DIR, f), v, { mode: 0o600 }); };

function arg(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : ""; }
const BASE = (arg("--base") || process.env.LIVEHTML_BASE_URL || readState("base-url")).replace(/\/+$/, "");
if (!BASE) { console.error("✗ no base url. Pass --base <url>, set LIVEHTML_BASE_URL, or install the skill first."); process.exit(1); }

function tokenExp(tok) {
  try {
    const p = tok.split(".")[0].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(p, "base64").toString("utf8")).exp || 0;
  } catch { return 0; }
}

function postRefresh(cur) {
  return new Promise((resolve) => {
    const u = new URL(BASE + "/auth/token/refresh");
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(u, { method: "POST", headers: { Authorization: "Bearer " + cur } }, (res) => {
      let b = ""; res.on("data", (d) => (b += d));
      res.on("end", () => { try { resolve(res.statusCode === 200 ? JSON.parse(b) : null); } catch { resolve(null); } });
    });
    req.on("error", () => resolve(null));
    req.end();
  });
}

function openBrowser(u) {
  const plat = process.platform;
  const cmd = plat === "darwin" ? "open" : plat === "win32" ? "cmd" : "xdg-open";
  const args = plat === "win32" ? ["/c", "start", "", u] : [u];
  try { spawn(cmd, args, { stdio: "ignore", detached: true }).unref(); } catch { /* user uses the printed URL */ }
}

function loopbackLogin() {
  return new Promise((resolve, reject) => {
    const nonce = crypto.randomBytes(16).toString("hex");
    let got = null;
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, "http://127.0.0.1");
      if (u.pathname !== "/cb") { res.writeHead(404); res.end(); return; }
      if (u.searchParams.get("n") !== nonce) { res.writeHead(400); res.end("bad nonce"); return; }
      got = { token: u.searchParams.get("token"), name: u.searchParams.get("name") || "", exp: u.searchParams.get("exp") || "" };
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<!doctype html><meta charset=utf-8><body style='font:16px sans-serif;text-align:center;margin-top:80px'>✓ 登录成功，可以关闭这个标签页。</body>");
      setTimeout(() => server.close(), 150);
    });
    const timer = setTimeout(() => { server.close(); reject(new Error("timed out waiting for login (120s)")); }, 120000);
    server.on("close", () => { clearTimeout(timer); got && got.token ? resolve(got) : reject(new Error("no token received")); });
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      const cb = `http://127.0.0.1:${port}/cb`;
      const next = `/auth/token?cli=${encodeURIComponent(cb)}&n=${nonce}`;
      const loginUrl = `${BASE}/auth/dingtalk/login?next=${encodeURIComponent(next)}`;
      console.log("→ 打开浏览器完成钉钉扫码登录（若没自动打开，手动访问）：\n  " + loginUrl);
      openBrowser(loginUrl);
    });
  });
}

(async () => {
  const now = Math.floor(Date.now() / 1000);
  const cur = readState("api-token");
  if (cur) {
    const exp = tokenExp(cur);
    if (exp - now > 7 * 86400) { console.log("✓ 已登录（token 仍有效）。"); return; }
    if (exp > now) {
      const r = await postRefresh(cur);
      if (r && r.token) { writeState("api-token", r.token); console.log(`✓ 已静默续期：${r.name}`); return; }
    }
  }
  try {
    const r = await loopbackLogin();
    writeState("api-token", r.token);
    const when = r.exp ? new Date(Number(r.exp) * 1000).toLocaleString("zh-CN") : "";
    console.log(`✓ 已登录：${r.name}${when ? "（" + when + " 过期）" : ""}\n  token → ${path.join(STATE_DIR, "api-token")}`);
  } catch (e) {
    console.error("✗ 登录失败：" + e.message);
    process.exit(1);
  }
})();
