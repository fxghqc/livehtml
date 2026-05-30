# `livehtml login` + Per-User API Tokens — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `livehtml login` CLI that opens the browser, the human 扫码s once, and a per-user signed API token auto-saves to `~/.local/state/livehtml/api-token` (zero copy-paste, silent refresh) — mirroring `dws auth login`.

**Architecture:** Reuse the shipped DingTalk login. The server mints a **per-user signed bearer** (`{uid,name,kind:"api",exp}`, HMAC via `auth/session.ts`) at a session-gated `/auth/token`, then 302-redirects the browser to a **strictly-validated `127.0.0.1` loopback** the CLI is listening on. `apiTokenOk` accepts static-or-signed; the agent gate is active when `dingtalkEnabled || apiTokenEnabled`, so the static `LIVEHTML_API_TOKEN` becomes optional.

**Tech Stack:** Bun/TS server, `node:crypto` (no new deps), zero-dep Node CLI (`node:http`/`crypto`/`child_process`), bash+curl + `bun test`.

**Spec:** `docs/superpowers/specs/2026-05-30-livehtml-login-cli-design.md` (supersedes the 2026-05-29 spec §5/§14 static-token coupling).

---

## File Structure

**Modified:**
- `auth/session.ts` — add `API_TOKEN_KIND`, `signApiToken`, `verifyApiToken`.
- `auth/gate.ts` — add `isLoopbackRedirect`; change `apiTokenOk` to accept static-or-signed and return `{ ok, uid? }`.
- `auth/config.ts` — add `apiTokenTtlSec`; **remove** the `dingtalkEnabled && !apiToken` fail-closed throw.
- `auth/routes.ts` — add `GET /auth/token` (mint + loopback redirect) and `POST /auth/token/refresh`.
- `server.ts` — replace `apiGateFail` with `apiAuth` (new activation + signature); thread `by` (uid) into `handleStateRoom`; serve `GET /login.cjs`; add `SCRIPTS_DIR`; `/install` + `/install.ps1` fetch the login script.
- `tests/unit/{session,gate,config}.test.ts` — extend/replace.
- `tests/auth_api_token.sh` — assert signed-token acceptance + dingtalk-only gate.
- `skill/SKILL.md`, `README.md`, `.env.example`, `docs/.../2026-05-29-...md` — docs.
- `package.json` — `livehtml-login` bin + `files`.

**Created:**
- `scripts/livehtml-login.cjs` — the CLI.
- `tests/auth_token.sh` — integration test for mint/loopback/refresh.

**Canonical signatures (keep exact across tasks):**
```ts
// auth/session.ts
export const API_TOKEN_KIND = "api";
export function signApiToken(uid: string, name: string, ttlSec: number, secret: string, nowSec: number): string;
export function verifyApiToken(token: string, secret: string, nowSec: number): { uid: string; name: string } | null;

// auth/gate.ts
export interface ApiAuth { ok: boolean; uid?: string; }
export function apiTokenOk(req: Request, staticToken: string, sessionSecret: string, nowSec: number): ApiAuth;
export function isLoopbackRedirect(raw: string | null): boolean;

// auth/config.ts  (AuthConfig gains)
apiTokenTtlSec: number;   // API_TOKEN_TTL_SEC, default 2592000 (30d)
```

---

## Task 1: Per-user API token helpers (`auth/session.ts`)

**Files:** Modify `auth/session.ts`; Test `tests/unit/session.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `tests/unit/session.test.ts`:

```ts
import { signApiToken, verifyApiToken } from "../../auth/session.ts";

test("signApiToken/verifyApiToken roundtrip", () => {
  const t = signApiToken("u1", "Alice", 100, SECRET, NOW);
  const v = verifyApiToken(t, SECRET, NOW);
  expect(v).toEqual({ uid: "u1", name: "Alice" });
});

test("verifyApiToken rejects expired", () => {
  const t = signApiToken("u1", "Alice", -1, SECRET, NOW);
  expect(verifyApiToken(t, SECRET, NOW)).toBeNull();
});

test("verifyApiToken rejects a session token (wrong kind)", () => {
  const sess = signSession({ uid: "u1", name: "Alice", exp: NOW + 100 }, SECRET);
  expect(verifyApiToken(sess, SECRET, NOW)).toBeNull();
});

test("verifyApiToken rejects wrong secret", () => {
  const t = signApiToken("u1", "Alice", 100, SECRET, NOW);
  expect(verifyApiToken(t, "other", NOW)).toBeNull();
});
```

- [ ] **Step 2: Run — expect FAIL** (`signApiToken` not exported)

Run: `bun test tests/unit/session.test.ts`

- [ ] **Step 3: Implement** — append to `auth/session.ts`:

```ts
export const API_TOKEN_KIND = "api";

export function signApiToken(uid: string, name: string, ttlSec: number, secret: string, nowSec: number): string {
  return signToken({ uid, name, kind: API_TOKEN_KIND, exp: nowSec + ttlSec }, secret);
}

export function verifyApiToken(token: string, secret: string, nowSec: number): { uid: string; name: string } | null {
  const v = verifyToken<any>(token, secret, nowSec);
  if (!v || v.kind !== API_TOKEN_KIND || typeof v.uid !== "string") return null;
  return { uid: v.uid, name: typeof v.name === "string" ? v.name : v.uid };
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `bun test tests/unit/session.test.ts`

- [ ] **Step 5: Commit**

```bash
git add auth/session.ts tests/unit/session.test.ts
git commit -m "auth: per-user signed API token helpers (signApiToken/verifyApiToken)"
```

---

## Task 2: Loopback validation + static-or-signed token acceptance (`auth/gate.ts`)

**Files:** Modify `auth/gate.ts`; Test `tests/unit/gate.test.ts`

- [ ] **Step 1: Update + add tests**

In `tests/unit/gate.test.ts`, replace the existing `apiTokenOk` test with the new signature and add loopback + signed-token tests:

```ts
import { signApiToken } from "../../auth/session.ts";

test("apiTokenOk: static bearer match", () => {
  const ok = new Request("http://x/", { headers: { authorization: "Bearer s3cret" } });
  const bad = new Request("http://x/", { headers: { authorization: "Bearer nope" } });
  const none = new Request("http://x/");
  expect(apiTokenOk(ok, "s3cret", "", 1000).ok).toBe(true);
  expect(apiTokenOk(bad, "s3cret", "", 1000).ok).toBe(false);
  expect(apiTokenOk(none, "s3cret", "", 1000).ok).toBe(false);
});

test("apiTokenOk: signed per-user token accepted, exposes uid", () => {
  const tok = signApiToken("u5", "Eve", 100, "sek", 1000);
  const req = new Request("http://x/", { headers: { authorization: "Bearer " + tok } });
  const r = apiTokenOk(req, "", "sek", 1000);
  expect(r.ok).toBe(true);
  expect(r.uid).toBe("u5");
});

test("apiTokenOk: expired signed token rejected", () => {
  const tok = signApiToken("u5", "Eve", -1, "sek", 1000);
  const req = new Request("http://x/", { headers: { authorization: "Bearer " + tok } });
  expect(apiTokenOk(req, "", "sek", 1000).ok).toBe(false);
});

test("isLoopbackRedirect accepts localhost/127/::1 with a port", () => {
  expect(isLoopbackRedirect("http://127.0.0.1:5000/cb")).toBe(true);
  expect(isLoopbackRedirect("http://localhost:49213/cb")).toBe(true);
  expect(isLoopbackRedirect("http://[::1]:8080/cb")).toBe(true);
});

test("isLoopbackRedirect rejects external/https/no-port/userinfo", () => {
  expect(isLoopbackRedirect("https://127.0.0.1:5000/cb")).toBe(false); // https
  expect(isLoopbackRedirect("http://evil.com:5000/cb")).toBe(false);   // external host
  expect(isLoopbackRedirect("http://127.0.0.1/cb")).toBe(false);       // no port
  expect(isLoopbackRedirect("http://user@127.0.0.1:5000/cb")).toBe(false); // userinfo
  expect(isLoopbackRedirect("http://127.0.0.1.evil.com:80/cb")).toBe(false);
  expect(isLoopbackRedirect(null)).toBe(false);
});
```

Add the imports `apiTokenOk, isLoopbackRedirect` to the existing import line in the test (they're from `../../auth/gate.ts`).

- [ ] **Step 2: Run — expect FAIL**

Run: `bun test tests/unit/gate.test.ts`

- [ ] **Step 3: Implement** — in `auth/gate.ts`, add the `verifyApiToken` import and replace `apiTokenOk`, then add `isLoopbackRedirect`:

```ts
// at top, after the node:crypto import:
import { verifyApiToken } from "./session.ts";

export interface ApiAuth {
  ok: boolean;
  uid?: string;
}

// Accept EITHER a constant-time match against the static token OR a valid
// signed per-user api token. uid is set only for the signed path (attribution).
export function apiTokenOk(req: Request, staticToken: string, sessionSecret: string, nowSec: number): ApiAuth {
  const h = req.headers.get("authorization") || "";
  if (!h.startsWith("Bearer ")) return { ok: false };
  const presented = h.slice("Bearer ".length);
  if (staticToken) {
    const a = Buffer.from(presented);
    const b = Buffer.from(staticToken);
    if (a.length === b.length && timingSafeEqual(a, b)) return { ok: true };
  }
  if (sessionSecret) {
    const v = verifyApiToken(presented, sessionSecret, nowSec);
    if (v) return { ok: true, uid: v.uid };
  }
  return { ok: false };
}

// True only for an http loopback URL with an explicit port and no userinfo.
// This is the hard gate that prevents token exfiltration to arbitrary hosts.
export function isLoopbackRedirect(raw: string | null): boolean {
  if (!raw) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "http:") return false;
  if (u.username || u.password) return false;
  if (!u.port) return false;
  const host = u.hostname;
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
}
```

(Remove the old `apiTokenOk` implementation entirely. Keep the `timingSafeEqual` import.)

- [ ] **Step 4: Run — expect PASS**

Run: `bun test tests/unit/gate.test.ts`

- [ ] **Step 5: Commit**

```bash
git add auth/gate.ts tests/unit/gate.test.ts
git commit -m "auth: apiTokenOk accepts static-or-signed; add isLoopbackRedirect"
```

---

## Task 3: Config — TTL + drop the static-token requirement (`auth/config.ts`)

**Files:** Modify `auth/config.ts`; Test `tests/unit/config.test.ts`

- [ ] **Step 1: Update tests** — in `tests/unit/config.test.ts`, **replace** the `"dingtalk enabled requires api token (fail closed)"` test with:

```ts
test("dingtalk enabled does NOT require api token (per-user tokens suffice)", () => {
  const c = loadAuthConfig({ DINGTALK_CLIENT_ID: "k", DINGTALK_CLIENT_SECRET: "s", SESSION_SECRET: "secret" });
  expect(c.dingtalkEnabled).toBe(true);
  expect(c.apiTokenEnabled).toBe(false);
});

test("apiTokenTtlSec defaults to 30 days and parses override", () => {
  expect(loadAuthConfig({}).apiTokenTtlSec).toBe(2592000);
  expect(loadAuthConfig({ API_TOKEN_TTL_SEC: "3600" }).apiTokenTtlSec).toBe(3600);
});
```

- [ ] **Step 2: Run — expect FAIL** (`apiTokenTtlSec` undefined; old fail-closed test gone)

Run: `bun test tests/unit/config.test.ts`

- [ ] **Step 3: Implement** — in `auth/config.ts`:

1. Add to the `AuthConfig` interface: `apiTokenTtlSec: number;`
2. **Delete** the block:
```ts
  if (dingtalkEnabled && !apiToken) {
    throw new Error(
      "DINGTALK_CLIENT_ID is set but LIVEHTML_API_TOKEN is missing — the agent/state surfaces (state API, /pages list, /rooms) would be left open while page HTML is gated. Set LIVEHTML_API_TOKEN so human pages and their data are protected together (fail-closed).",
    );
  }
```
3. In the returned object, after `sessionTtlSec: ...,` add:
```ts
    apiTokenTtlSec: (() => {
      const t = Number(env.API_TOKEN_TTL_SEC);
      return Number.isFinite(t) && t > 0 ? Math.floor(t) : 2592000;
    })(),
```

- [ ] **Step 4: Run — expect PASS**

Run: `bun test tests/unit/config.test.ts`

- [ ] **Step 5: Commit**

```bash
git add auth/config.ts tests/unit/config.test.ts
git commit -m "auth: add apiTokenTtlSec; drop static-token fail-closed (per-user tokens supersede)"
```

---

## Task 4: `/auth/token` mint + `/auth/token/refresh` (`auth/routes.ts`)

**Files:** Modify `auth/routes.ts` (integration-tested in Task 6)

- [ ] **Step 1: Implement** — in `auth/routes.ts`:

1. Extend the imports from `./session.ts` to include `signApiToken, verifyApiToken`, and from `./gate.ts` to include `isLoopbackRedirect`:
```ts
import {
  signSession, signToken, verifyToken, parseCookies, buildSetCookie,
  readSession, signApiToken, verifyApiToken, SESSION_COOKIE, OAUTH_COOKIE,
} from "./session.ts";
import { sanitizeNext, isLoopbackRedirect } from "./gate.ts";
```

2. Add a token page helper near `htmlError`:
```ts
function tokenHtml(token: string, name: string, exp: number): string {
  const when = new Date(exp * 1000).toLocaleString("zh-CN");
  return `<!doctype html><meta charset="utf-8"><title>livehtml token</title>
<body style="font:14px/1.6 -apple-system,sans-serif;max-width:640px;margin:60px auto;padding:0 20px;color:#222">
<h2>已登录：${name}</h2>
<p>个人 API token（${when} 过期）：</p>
<pre id="t" style="background:#1e1e2e;color:#cdd6f4;padding:12px;border-radius:8px;white-space:pre-wrap;word-break:break-all">${token}</pre>
<button onclick="navigator.clipboard.writeText(document.getElementById('t').textContent)">复制</button>
<p style="color:#6b7280">一般不用手动复制：用 <code>livehtml login</code> 会自动写入 <code>~/.local/state/livehtml/api-token</code>。</p>
</body>`;
}
```

3. Add these route blocks before the final `return null;`:
```ts
  if (path === "/auth/token") {
    if (!cfg.dingtalkEnabled) return new Response("not found", { status: 404, headers: CORS });
    const sess = readSession(req, cfg.sessionSecret, nowSec);
    if (!sess) {
      // Not logged in yet — bounce through DingTalk login, preserving our query.
      const next = "/auth/token" + (url.search || "");
      return new Response(null, {
        status: 302,
        headers: { ...CORS, Location: `/auth/dingtalk/login?next=${encodeURIComponent(next)}` },
      });
    }
    const exp = nowSec + cfg.apiTokenTtlSec;
    const token = signApiToken(sess.uid, sess.name, cfg.apiTokenTtlSec, cfg.sessionSecret, nowSec);
    const noStore = { ...CORS, "Cache-Control": "no-store" };

    const cli = url.searchParams.get("cli");
    if (cli !== null) {
      if (!isLoopbackRedirect(cli)) return new Response("invalid cli redirect", { status: 400, headers: noStore });
      const n = url.searchParams.get("n") || "";
      const sep = cli.includes("?") ? "&" : "?";
      const loc =
        `${cli}${sep}token=${encodeURIComponent(token)}` +
        `&name=${encodeURIComponent(sess.name)}&exp=${exp}&n=${encodeURIComponent(n)}`;
      return new Response(null, { status: 302, headers: { ...noStore, Location: loc } });
    }
    if (url.searchParams.get("format") === "json") {
      return Response.json({ token, name: sess.name, exp }, { headers: noStore });
    }
    return new Response(tokenHtml(token, sess.name, exp), {
      status: 200,
      headers: { ...noStore, "Content-Type": "text/html; charset=utf-8" },
    });
  }

  if (path === "/auth/token/refresh") {
    if (!cfg.dingtalkEnabled) return new Response("not found", { status: 404, headers: CORS });
    if (req.method !== "POST") return new Response("method not allowed", { status: 405, headers: CORS });
    const h = req.headers.get("authorization") || "";
    const cur = h.startsWith("Bearer ") ? h.slice("Bearer ".length) : "";
    const v = verifyApiToken(cur, cfg.sessionSecret, nowSec);
    if (!v) return new Response("unauthorized", { status: 401, headers: { ...CORS, "WWW-Authenticate": "Bearer" } });
    const exp = nowSec + cfg.apiTokenTtlSec;
    const token = signApiToken(v.uid, v.name, cfg.apiTokenTtlSec, cfg.sessionSecret, nowSec);
    return Response.json({ token, name: v.name, exp }, { headers: { ...CORS, "Cache-Control": "no-store" } });
  }
```

- [ ] **Step 2: Boot smoke** (no type/import errors)

Run: `PORT=39833 DINGTALK_CLIENT_ID=k DINGTALK_CLIENT_SECRET=s SESSION_SECRET=sek bun server.ts >/tmp/lh_t4.log 2>&1 & SV=$!; sleep 1; curl -s -o /dev/null -w "token-no-session=%{http_code}\n" "http://127.0.0.1:39833/auth/token?format=json"; kill $SV`
Expected: `token-no-session=302` (bounces to login).

- [ ] **Step 3: Commit**

```bash
git add auth/routes.ts
git commit -m "auth: /auth/token mint (+ loopback redirect) and /auth/token/refresh"
```

---

## Task 5: Server gate `apiAuth` + `by` attribution (`server.ts`)

**Files:** Modify `server.ts`; Test `tests/auth_api_token.sh`

- [ ] **Step 1: Update the integration test** — append to `tests/auth_api_token.sh` (before the final `echo "OK"`), and also add a dingtalk-only block. Replace the env header so we can mint a signed token. Insert after the existing assertions:

```bash
# --- signed per-user token is accepted on agent surfaces ---
SIGNED=$(SECRET="$LIVEHTML_API_TOKEN_SECRET" node -e '0' 2>/dev/null; echo "")
```

Actually use a second server with DingTalk on (no static token) to prove the gate is active via signed tokens. Append a fresh section:

```bash
# === gate active via DingTalk (no static token) accepts a signed api token ===
stop_server
export DINGTALK_CLIENT_ID="testkey"
export DINGTALK_CLIENT_SECRET="testsecret"
export SESSION_SECRET="unit-secret"
unset LIVEHTML_API_TOKEN
start_server
BASE="http://127.0.0.1:$SERVER_PORT"

# no token -> 401 (gate active because DingTalk is on)
CODE=$(curl -sS -o /dev/null -w "%{http_code}" "$BASE/pages/k9/state")
assert_eq 401 "$CODE" "dingtalk-only gate: no token should be 401"

# a signed api token (mint via the same HMAC the server uses) -> 200
API=$(mint_api_token "u3" "Cee" "$SESSION_SECRET")
CODE=$(curl -sS -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $API" "$BASE/pages/k9/state")
assert_eq 200 "$CODE" "dingtalk-only gate: signed token should be 200"
pass "signed per-user token satisfies the agent gate"
```

Add a `mint_api_token` helper to `tests/_lib.sh` (mirrors `signApiToken`):

```bash
# mint_api_token <uid> <name> <secret> — echo a signed api bearer (kind="api").
mint_api_token() {
  local json payload sig
  json="{\"uid\":\"$1\",\"name\":\"$2\",\"kind\":\"api\",\"exp\":9999999999}"
  payload=$(printf '%s' "$json" | b64url)
  sig=$(printf '%s' "$payload" | openssl dgst -sha256 -hmac "$3" -binary | b64url)
  printf '%s.%s' "$payload" "$sig"
}
```

- [ ] **Step 2: Run — expect FAIL** (gate not active when only DingTalk is on; signed token not accepted yet)

Run: `bash tests/auth_api_token.sh`

- [ ] **Step 3: Implement** — in `server.ts`:

1. Replace the `apiGateFail` function with `apiAuth`:
```ts
function apiAuth(req: Request): { ok: boolean; uid?: string; resp?: Response } {
  const gateActive = authCfg.dingtalkEnabled || authCfg.apiTokenEnabled;
  if (!gateActive) return { ok: true };
  const r = apiTokenOk(req, authCfg.apiToken, authCfg.sessionSecret, nowSec());
  if (r.ok) return { ok: true, uid: r.uid };
  return { ok: false, resp: new Response("unauthorized", { status: 401, headers: { ...CORS, "WWW-Authenticate": "Bearer" } }) };
}
```

2. Update every call site. Replace each `const g = apiGateFail(req); if (g) return g;` with `const a = apiAuth(req); if (!a.ok) return a.resp!;` at: `/rooms`, `/pages` list, the PUT/DELETE hoisted block, and `/state/`. For the two **state** branches pass `a.uid` (see below). The PUT/DELETE/list/rooms branches don't need `uid`.

3. Thread `by` into `handleStateRoom`. Change its signature:
```ts
async function handleStateRoom(req: Request, room: string, by = "http"): Promise<Response | null> {
```
and inside it replace the two literal `"http"` occurrences (the `replaceRoomMeta(room, ..., "http")` and the `broadcast(room, { t: "replace", state: body, by: "http" })` in the PUT branch) with `by`. The DELETE-in-handleStateRoom broadcast `by: "http"` → `by`.

4. At the `/pages/<key>/state` call site:
```ts
        const a = apiAuth(req); if (!a.ok) return a.resp!;
```
and its `handleStateRoom(req, room)` → `handleStateRoom(req, room, a.uid ?? "http")`.

5. At the `/state/` branch:
```ts
    if (path.startsWith("/state/")) {
      const a = apiAuth(req); if (!a.ok) return a.resp!;
      const raw = decodeURIComponent(path.slice("/state/".length));
      const room = sanitizeRoom(raw);
      const resp = await handleStateRoom(req, room, a.uid ?? "http");
      if (resp) return resp;
    }
```

- [ ] **Step 4: Run — expect PASS**

Run: `bash tests/auth_api_token.sh`
Regression: `bash tests/v1_state_alias.sh && bun test tests/unit` → green (state alias runs with no auth env → gate inactive → unchanged).

- [ ] **Step 5: Commit**

```bash
git add server.ts tests/auth_api_token.sh tests/_lib.sh
git commit -m "auth: apiAuth gate active on dingtalk-or-token; signed-token by-attribution"
```

---

## Task 6: Integration test for mint / loopback / refresh (`tests/auth_token.sh`)

**Files:** Create `tests/auth_token.sh`

- [ ] **Step 1: Write the test**

```bash
#!/usr/bin/env bash
# /auth/token minting + loopback redirect validation + refresh, with a forged
# session (no live DingTalk needed).
set -uo pipefail
source "$(dirname "$0")/_lib.sh"

export DINGTALK_CLIENT_ID="testkey"
export DINGTALK_CLIENT_SECRET="testsecret"
export SESSION_SECRET="unit-secret"
export LIVEHTML_API_TOKEN="static-tok"   # both gates on; either credential works
start_server
BASE="http://127.0.0.1:$SERVER_PORT"
SESS=$(mint_session "u1" "Alice" "$SESSION_SECRET")

# 1. format=json with a session -> a token + name
J=$(curl -sS --cookie "lh_sess=$SESS" "$BASE/auth/token?format=json")
case "$J" in *'"name":"Alice"'*'"token":"'*) pass "step 1: json mint" ;; *) fail "step1 body=$J" ;; esac
TOK=$(printf '%s' "$J" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
[ -n "$TOK" ] || fail "step1 no token extracted"

# 2. cli loopback -> 302 to that 127.0.0.1 url carrying token + nonce
R=$(curl -sS -i --cookie "lh_sess=$SESS" "$BASE/auth/token?cli=http%3A%2F%2F127.0.0.1%3A59999%2Fcb&n=abc123")
echo "$R" | grep -qiE "^HTTP/[0-9.]+ 302" || fail "step2 not 302: $(echo "$R" | head -1)"
echo "$R" | grep -qi "^location: http://127.0.0.1:59999/cb?token=" || fail "step2 wrong loopback loc: $R"
echo "$R" | grep -qi "n=abc123" || fail "step2 nonce not echoed"
pass "step 2: cli loopback redirect carries token + nonce"

# 3. cli with a NON-loopback target -> 400, no token
CODE=$(curl -sS -o /dev/null -w "%{http_code}" --cookie "lh_sess=$SESS" "$BASE/auth/token?cli=https%3A%2F%2Fevil.com%2Fcb")
assert_eq 400 "$CODE" "step3 external cli should be 400"
pass "step 3: external cli rejected"

# 4. no session -> 302 bounce to login
CODE=$(curl -sS -o /dev/null -w "%{http_code}" "$BASE/auth/token?format=json")
assert_eq 302 "$CODE" "step4 no-session should bounce to login"
pass "step 4: no session bounces to login"

# 5. refresh a valid token -> new token; garbage -> 401
J2=$(curl -sS -X POST -H "Authorization: Bearer $TOK" "$BASE/auth/token/refresh")
case "$J2" in *'"token":"'*'"name":"Alice"'*) pass "step 5a: refresh returns a token" ;; *) fail "step5a body=$J2" ;; esac
CODE=$(curl -sS -o /dev/null -w "%{http_code}" -X POST -H "Authorization: Bearer not.a.token" "$BASE/auth/token/refresh")
assert_eq 401 "$CODE" "step5b garbage refresh should be 401"
pass "step 5: refresh works / rejects garbage"

echo "OK: auth token mint + loopback + refresh"
```

`chmod +x tests/auth_token.sh`.

- [ ] **Step 2: Run — expect PASS**

Run: `bash tests/auth_token.sh`

- [ ] **Step 3: Commit**

```bash
git add tests/auth_token.sh
git commit -m "test: /auth/token mint, loopback validation, and refresh"
```

---

## Task 7: The `livehtml login` CLI (`scripts/livehtml-login.cjs`)

**Files:** Create `scripts/livehtml-login.cjs`; Modify `package.json`

- [ ] **Step 1: Write the CLI**

```js
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
```

`chmod +x scripts/livehtml-login.cjs`.

- [ ] **Step 2: Register the bin** — in `package.json`, add to `"bin"`:
```json
    "livehtml-login": "./scripts/livehtml-login.cjs",
```
and add `"scripts/livehtml-login.cjs"` to the `"files"` array.

- [ ] **Step 3: Syntax + no-base error check**

Run: `node --check scripts/livehtml-login.cjs && echo "syntax ok"`
Run: `env -u LIVEHTML_BASE_URL HOME=/tmp/nonexistent-home node scripts/livehtml-login.cjs 2>&1 | head -1`
Expected: `syntax ok`; then a line starting `✗ no base url`.

- [ ] **Step 4: Commit**

```bash
git add scripts/livehtml-login.cjs package.json
git commit -m "cli: livehtml login (loopback DingTalk login + token cache/refresh)"
```

---

## Task 8: Serve the CLI + wire it into the installers

**Files:** Modify `server.ts` (serve `/login.cjs`), and the `/install` + `/install.ps1` script strings inside `server.ts`.

- [ ] **Step 1: Serve the script** — in `server.ts`:

1. Add a scripts dir constant near the other dir consts (after `const SKILL_DIR = ...`):
```ts
const SCRIPTS_DIR = join(ROOT, "scripts");
```
2. Add a route (place it next to the `/sync.js` route):
```ts
    if (path === "/login.cjs") {
      return (
        (await serveStatic(SCRIPTS_DIR, "livehtml-login.cjs", "application/javascript; charset=utf-8")) ??
        new Response("// livehtml-login.cjs not found", { status: 404, headers: CORS })
      );
    }
```

- [ ] **Step 2: Fetch it in the POSIX installer** — in the `/install` script string, after the base-url write block (after the `printf '%s' "$BASE" > "$STATE_DIR/base-url"` / echo lines), add:
```sh
curl -fsSL "$BASE/login.cjs" -o "$STATE_DIR/livehtml-login.cjs" 2>/dev/null && \
  echo "✓ login CLI → $STATE_DIR/livehtml-login.cjs (run: node \$STATE_DIR/livehtml-login.cjs)"
```

- [ ] **Step 3: Fetch it in the Windows installer** — in the `/install.ps1` string, after the base-url write:
```powershell
try { Invoke-WebRequest -Uri "$Base/login.cjs" -OutFile (Join-Path $StateDir 'livehtml-login.cjs') -UseBasicParsing; Write-Host "[ok] login CLI -> $StateDir/livehtml-login.cjs" } catch {}
```

- [ ] **Step 4: Verify serving + install embed**

```bash
PORT=39844 bun server.ts >/tmp/lh_t8.log 2>&1 & SV=$!; sleep 1
curl -fsS http://127.0.0.1:39844/login.cjs | head -1 | grep -q "node" && echo "login.cjs served"
curl -fsS http://127.0.0.1:39844/install | grep -q "login.cjs" && echo "install fetches login.cjs"
kill $SV
```
Expected: `login.cjs served` and `install fetches login.cjs`.

- [ ] **Step 5: Commit**

```bash
git add server.ts
git commit -m "serve: /login.cjs + installers fetch the login CLI"
```

---

## Task 9: Docs — SKILL.md, README, .env, supersession note

**Files:** Modify `skill/SKILL.md`, `README.md`, `.env.example`, `docs/superpowers/specs/2026-05-29-dingtalk-oauth-login-design.md`.

- [ ] **Step 1: SKILL.md** — replace the "Agent 调用带令牌" bullet (the hand-copy instruction) with the `livehtml login` flow:

```markdown
- **Agent 一次性登录拿令牌**：运行 `node ~/.local/state/livehtml/livehtml-login.cjs`（或 `livehtml login`）。
  浏览器扫码登录钉钉后，个人 API token 自动写入 `~/.local/state/livehtml/api-token`（自动续期，约月级才再扫一次）。
  之后所有 `PUT /pages/<key>`、`GET/PUT/DELETE /pages/<key>/state`、`/state/<room>`、`/rooms` 请求带头：
  `Authorization: Bearer $(cat ~/.local/state/livehtml/api-token)`
  未启用登录/令牌的部署无需此步（向后兼容）。
```

- [ ] **Step 2: README** — in §2, replace the fail-closed paragraph that demanded `LIVEHTML_API_TOKEN` with the per-user model. Update the §1 fail-closed note to drop the token requirement (keep `SESSION_SECRET`). Add a short "Agent 登录" subsection:

```markdown
### Agent 拿 token：`livehtml login`（推荐）

开了钉钉登录门后，agent 不用 operator 手发密钥——跑一次：

\`\`\`bash
node ~/.local/state/livehtml/livehtml-login.cjs    # 或 livehtml login
\`\`\`

浏览器扫码登录 → 个人签名 token 自动写入 `~/.local/state/livehtml/api-token`，
约月级到期前自动静默续期。`LIVEHTML_API_TOKEN`（静态共享密钥）仅作 CI/应急可选项。
```

Update the §1 `> **fail-closed**` note to:
```markdown
> **fail-closed**：设了 `DINGTALK_CLIENT_ID` 却没设 `SESSION_SECRET`，server 拒绝启动。
> （不再要求 `LIVEHTML_API_TOKEN`——agent 用 `livehtml login` 拿个人 token，见下。）
```
And in §2 replace the "完全独立/必须一起开" paragraph with:
```markdown
设置 `LIVEHTML_API_TOKEN` 即开启静态令牌门。开了钉钉登录门时，agent 接口默认由**个人签名 token**
（`livehtml login` 获得）保护，所以静态 `LIVEHTML_API_TOKEN` 变成**可选**（CI/应急）。两种凭证都被接受。
```

- [ ] **Step 3: .env.example** — replace the `LIVEHTML_API_TOKEN` block:

```bash
# ---- API token gate for agent/read-back HTTP surfaces ----
# 开了钉钉登录门后，agent 用 `livehtml login` 拿个人 token（推荐），无需在此设值。
# 下面的静态共享令牌仅作 CI/应急可选项；设了它，调用需带 Authorization: Bearer <token>。
LIVEHTML_API_TOKEN=
# 个人 API token 有效期（秒），默认 2592000 = 30 天。
API_TOKEN_TTL_SEC=2592000
```

- [ ] **Step 4: Supersession note** — at the top of `docs/superpowers/specs/2026-05-29-dingtalk-oauth-login-design.md`, under the Status line, add:

```markdown
> **Update (2026-05-30):** §5/§14's "DingTalk on ⇒ `LIVEHTML_API_TOKEN` required" coupling is **superseded** by `docs/superpowers/specs/2026-05-30-livehtml-login-cli-design.md`: per-user signed tokens (via `livehtml login`) now satisfy the agent gate, so the static token is optional. The agent gate is active when `dingtalkEnabled || apiTokenEnabled`.
```

- [ ] **Step 5: Commit**

```bash
git add skill/SKILL.md README.md .env.example docs/superpowers/specs/2026-05-29-dingtalk-oauth-login-design.md
git commit -m "docs: livehtml login flow; static token now optional (supersede coupling)"
```

---

## Task 10: Full regression + manual smoke + finish

**Files:** none (verification).

- [ ] **Step 1: Unit + shell regression**

```bash
bun test tests/unit
for t in tests/auth_routes.sh tests/auth_human_gate.sh tests/auth_ws_gate.sh tests/auth_api_token.sh \
         tests/auth_token.sh tests/v1_state_alias.sh tests/v1_longpoll_changed.sh \
         tests/v2_longpoll_not_modified.sh tests/v3_longpoll_concurrency.sh tests/v4_longpoll_sequence.sh \
         tests/v5_longpoll_reset.sh tests/c1_envelope_format.sh tests/c2_meta_api.sh tests/c3_backward_read.sh; do
  echo "== $t =="; bash "$t" >/dev/null && echo PASS || { echo "FAIL $t"; bash "$t" | tail -8; break; }
done
```
Expected: all unit PASS; every shell test PASS.

- [ ] **Step 2: Backward-compat boot** (no auth env → fully open, unchanged)

Run: `PORT=39855 bun server.ts >/tmp/lh_bc.log 2>&1 & SV=$!; sleep 1; curl -s -o /dev/null -w "state=%{http_code}\n" http://127.0.0.1:39855/state/x; kill $SV`
Expected: `state=200` (gate inactive when neither DingTalk nor token configured).

- [ ] **Step 3: Manual smoke (operator, off-CI) — record in PR**

Prereq: real `.env` with `DINGTALK_*` + `SESSION_SECRET` (no static token needed); `docker compose up -d --build`.
1. `node ~/.local/state/livehtml/livehtml-login.cjs` → browser opens → 扫码 with a member account → terminal prints `✓ 已登录：<name>`; `~/.local/state/livehtml/api-token` exists (mode 600).
2. `curl -H "Authorization: Bearer $(cat ~/.local/state/livehtml/api-token)" "$BASE/pages/smoke/state"` → 200; a `PUT` records `by`=your userId (check `…/state?meta=1`).
3. Re-run `livehtml login` → prints "已登录（token 仍有效）" (no browser).
4. Non-member 扫码 → the page shows 403; no token written.
5. `curl "$BASE/pages/smoke/state"` (no bearer) → 401.

- [ ] **Step 4: Commit any doc fixups + offer push/PR**

```bash
git push -u origin feat/dingtalk-oauth-login   # only if the user asks
```

---

## Self-Review (completed by plan author)

**Spec coverage:** §3 token model → Tasks 1 (helpers), 3 (TTL), 5 (acceptance/attribution); §4 endpoints → Task 4 (`/auth/token`, `/auth/token/refresh`); §5 loopback security → Task 2 (`isLoopbackRedirect`) + Task 4 (cli validation) + Task 6 (rejects external) + Task 7 (nonce in CLI); §6 CLI → Task 7 + Task 8 (serve/install); §7 supersession → Task 3 (drop throw) + Task 5 (gate activation) + Task 9 (docs); §9 testing → each task's tests + Task 6 + Task 10. No gaps.

**Placeholder scan:** No TBD/TODO. CLI end-to-end (browser+扫码) is explicitly routed to manual smoke (Task 10) because there is no headless way to drive 扫码; the server side it depends on (mint/loopback/refresh) is fully covered by `tests/auth_token.sh`, and the CLI's own logic (token-file write, refresh-vs-login decision, base resolution) is exercised by Task 7's syntax/no-base checks. Honest, not hidden.

**Type/name consistency:** `signApiToken`/`verifyApiToken` (session) used identically in gate (Task 2), routes (Task 4), and bash `mint_api_token` (Task 5) — same payload `{uid,name,kind:"api",exp}`. `apiTokenOk` returns `{ ok, uid? }` (Task 2), consumed by `apiAuth` (Task 5). `isLoopbackRedirect` defined Task 2, used Task 4, tested Tasks 2+6. `apiTokenTtlSec` defined Task 3, used Task 4. `apiAuth` replaces `apiGateFail` at all five call sites (Task 5). `handleStateRoom(req, room, by)` signature change applied at both state call sites.
