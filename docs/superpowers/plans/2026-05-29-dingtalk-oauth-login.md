# DingTalk OAuth Login Gateway — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional DingTalk 扫码登录 gate in front of deployed `/pages/<key>` pages, enforced entirely in `server.ts` + `public/sync.js`, so generated HTML never changes.

**Architecture:** Two orthogonal, env-toggled gates. (1) A **DingTalk session gate** on human surfaces (`GET /pages/<key>` HTML + `/ws`) using a stateless HMAC-signed cookie minted after an OAuth2 authorization-code login that verifies corp membership. (2) A **static API-token gate** on agent read-back surfaces (state HTTP API, page upload). Auth logic lives in small, unit-testable `auth/*.ts` modules wired into `server.ts`; the verified identity feeds presence + a trustworthy `by`.

**Tech Stack:** Bun (HTTP + WebSocket), TypeScript, `node:crypto` (HMAC/timing-safe compare — no new deps), MinIO (existing), bash+curl integration tests + `bun test` unit tests.

**Spec:** `docs/superpowers/specs/2026-05-29-dingtalk-oauth-login-design.md`

---

## File Structure

**New files (auth modules — pure where possible, injectable I/O):**
- `auth/config.ts` — `loadAuthConfig(env)` → `AuthConfig`; fail-closed validation.
- `auth/session.ts` — generic signed-token (`signToken`/`verifyToken`), session helpers (`signSession`/`readSession`), cookie helpers (`buildSetCookie`/`clearCookie`/`parseCookies`). Uses `node:crypto`.
- `auth/gate.ts` — pure decisions: `sanitizeNext`, `apiTokenOk`, `humanAllowed`, `parsePublicMeta`.
- `auth/dingtalk.ts` — `createDingTalkClient(cfg, fetchImpl?, clock?)` → `{ verifyAuthCode }`; cached APP token + the 4 outbound calls + org gate.
- `auth/routes.ts` — `handleAuthRoute(req, url, cfg, client, nowSec)` → `Response | null` for `/auth/*`.

**New tests:**
- `tests/unit/session.test.ts`, `tests/unit/gate.test.ts`, `tests/unit/dingtalk.test.ts`, `tests/unit/config.test.ts` (`bun test`).
- `tests/auth_routes.sh`, `tests/auth_human_gate.sh`, `tests/auth_ws_gate.sh`, `tests/auth_api_token.sh` (shell).

**Modified files:**
- `server.ts` — wire config, `/auth/*`, human gate, API-token gate, X-Public, identity → `by`/presence.
- `public/sync.js` — fetch `/auth/me`, use real name, hide rename, handle `denied`.
- `tests/_lib.sh` — symlink `auth/` into rundir; add `mint_session` helper.
- `Dockerfile` — `COPY auth ./auth`.
- `.env.example`, `docker-compose.yml` — new env vars (placeholders only).
- `skill/SKILL.md`, `scripts/install-skill.cjs`, server-generated `/install` + `/install.ps1` — API-token + `X-Public` docs.
- `README.md` — auth section.
- `package.json` — `test:unit` script.

**Canonical interfaces (used across tasks — keep names exact):**

```ts
// auth/config.ts
export interface AuthConfig {
  dingtalkEnabled: boolean;
  clientId: string; clientSecret: string; corpId: string;
  baseUrl: string;          // LIVEHTML_PUBLIC_BASE_URL, "" => derive from request
  sessionSecret: string; sessionTtlSec: number;
  apiTokenEnabled: boolean; apiToken: string;
}
export function loadAuthConfig(env: Record<string, string | undefined>): AuthConfig;

// auth/session.ts
export const SESSION_COOKIE = "lh_sess";
export const OAUTH_COOKIE = "lh_oauth";
export interface SessionPayload { uid: string; name: string; exp: number; }
export function signToken(obj: Record<string, unknown>, secret: string): string;
export function verifyToken<T = any>(token: string, secret: string, nowSec: number): T | null;
export function signSession(p: SessionPayload, secret: string): string;
export function parseCookies(header: string | null): Record<string, string>;
export function readSession(req: Request, secret: string, nowSec: number): SessionPayload | null;
export function buildSetCookie(name: string, value: string, opts: { ttlSec: number; path: string; secure?: boolean; httpOnly?: boolean; sameSite?: "Lax" | "Strict" | "None" }): string;

// auth/gate.ts
export function sanitizeNext(raw: string | null): string;        // safe same-origin relative path, default "/"
export function apiTokenOk(req: Request, token: string): boolean; // Authorization: Bearer <token>, constant-time
export function humanAllowed(a: { gateOn: boolean; isPublic: boolean; hasSession: boolean }): boolean;
export function parsePublicMeta(metaData: Record<string, string> | undefined): boolean;

// auth/dingtalk.ts
export type VerifyResult = { ok: true; userId: string; name: string } | { ok: false; reason: "not_member" | "error" };
export interface DingTalkClient { verifyAuthCode(authCode: string): Promise<VerifyResult>; }
export function createDingTalkClient(
  cfg: { clientId: string; clientSecret: string; corpId: string },
  fetchImpl?: typeof fetch,
  clock?: () => number,
): DingTalkClient;
```

---

## Task 1: Config module (`auth/config.ts`)

**Files:**
- Create: `auth/config.ts`
- Test: `tests/unit/config.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/config.test.ts
import { test, expect } from "bun:test";
import { loadAuthConfig } from "../../auth/config.ts";

test("disabled when no client id", () => {
  const c = loadAuthConfig({});
  expect(c.dingtalkEnabled).toBe(false);
  expect(c.apiTokenEnabled).toBe(false);
});

test("dingtalk enabled requires session secret (fail closed)", () => {
  expect(() => loadAuthConfig({ DINGTALK_CLIENT_ID: "k", DINGTALK_CLIENT_SECRET: "s" }))
    .toThrow(/SESSION_SECRET/);
});

test("parses full config", () => {
  const c = loadAuthConfig({
    DINGTALK_CLIENT_ID: "k", DINGTALK_CLIENT_SECRET: "s", DINGTALK_CORP_ID: "corp",
    LIVEHTML_PUBLIC_BASE_URL: "http://h:39191", SESSION_SECRET: "secret",
    SESSION_TTL_SEC: "3600", LIVEHTML_API_TOKEN: "tok",
  });
  expect(c.dingtalkEnabled).toBe(true);
  expect(c.clientId).toBe("k");
  expect(c.baseUrl).toBe("http://h:39191");
  expect(c.sessionTtlSec).toBe(3600);
  expect(c.apiTokenEnabled).toBe(true);
  expect(c.apiToken).toBe("tok");
});

test("api token gate is independent of dingtalk", () => {
  const c = loadAuthConfig({ LIVEHTML_API_TOKEN: "tok" });
  expect(c.dingtalkEnabled).toBe(false);
  expect(c.apiTokenEnabled).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/config.test.ts`
Expected: FAIL — `Cannot find module '../../auth/config.ts'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// auth/config.ts
export interface AuthConfig {
  dingtalkEnabled: boolean;
  clientId: string;
  clientSecret: string;
  corpId: string;
  baseUrl: string;
  sessionSecret: string;
  sessionTtlSec: number;
  apiTokenEnabled: boolean;
  apiToken: string;
}

export function loadAuthConfig(env: Record<string, string | undefined>): AuthConfig {
  const clientId = (env.DINGTALK_CLIENT_ID || "").trim();
  const clientSecret = (env.DINGTALK_CLIENT_SECRET || "").trim();
  const sessionSecret = (env.SESSION_SECRET || "").trim();
  const dingtalkEnabled = clientId.length > 0;
  if (dingtalkEnabled && !sessionSecret) {
    throw new Error(
      "DINGTALK_CLIENT_ID is set but SESSION_SECRET is missing — refusing to start the login gate half-configured (fail-closed). Set SESSION_SECRET.",
    );
  }
  if (dingtalkEnabled && !clientSecret) {
    throw new Error("DINGTALK_CLIENT_ID is set but DINGTALK_CLIENT_SECRET is missing.");
  }
  const ttl = Number(env.SESSION_TTL_SEC);
  const apiToken = (env.LIVEHTML_API_TOKEN || "").trim();
  return {
    dingtalkEnabled,
    clientId,
    clientSecret,
    corpId: (env.DINGTALK_CORP_ID || "").trim(),
    baseUrl: (env.LIVEHTML_PUBLIC_BASE_URL || "").trim().replace(/\/+$/, ""),
    sessionSecret,
    sessionTtlSec: Number.isFinite(ttl) && ttl > 0 ? Math.floor(ttl) : 604800,
    apiTokenEnabled: apiToken.length > 0,
    apiToken,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/config.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add auth/config.ts tests/unit/config.test.ts
git commit -m "auth: config loader with fail-closed validation"
```

---

## Task 2: Session + cookie module (`auth/session.ts`)

**Files:**
- Create: `auth/session.ts`
- Test: `tests/unit/session.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/session.test.ts
import { test, expect } from "bun:test";
import {
  signToken, verifyToken, signSession, readSession,
  parseCookies, buildSetCookie, SESSION_COOKIE,
} from "../../auth/session.ts";

const SECRET = "test-secret";
const NOW = 1_000_000;

test("signToken/verifyToken roundtrip", () => {
  const t = signToken({ uid: "u1", name: "Alice", exp: NOW + 100 }, SECRET);
  const v = verifyToken<{ uid: string; name: string }>(t, SECRET, NOW);
  expect(v?.uid).toBe("u1");
  expect(v?.name).toBe("Alice");
});

test("rejects tampered payload", () => {
  const t = signToken({ uid: "u1", exp: NOW + 100 }, SECRET);
  const [, sig] = t.split(".");
  const forged = Buffer.from(JSON.stringify({ uid: "admin", exp: NOW + 100 }))
    .toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") + "." + sig;
  expect(verifyToken(forged, SECRET, NOW)).toBeNull();
});

test("rejects wrong secret", () => {
  const t = signToken({ uid: "u1", exp: NOW + 100 }, SECRET);
  expect(verifyToken(t, "other", NOW)).toBeNull();
});

test("rejects expired token", () => {
  const t = signToken({ uid: "u1", exp: NOW - 1 }, SECRET);
  expect(verifyToken(t, SECRET, NOW)).toBeNull();
});

test("readSession reads lh_sess cookie", () => {
  const tok = signSession({ uid: "u9", name: "Bob", exp: NOW + 100 }, SECRET);
  const req = new Request("http://x/", { headers: { cookie: `foo=1; ${SESSION_COOKIE}=${tok}; bar=2` } });
  const s = readSession(req, SECRET, NOW);
  expect(s?.uid).toBe("u9");
  expect(s?.name).toBe("Bob");
});

test("readSession returns null without cookie", () => {
  expect(readSession(new Request("http://x/"), SECRET, NOW)).toBeNull();
});

test("parseCookies handles empty + multiple", () => {
  expect(parseCookies(null)).toEqual({});
  expect(parseCookies("a=1; b=2")).toEqual({ a: "1", b: "2" });
});

test("buildSetCookie sets flags; Secure only when asked", () => {
  const insecure = buildSetCookie("lh_sess", "v", { ttlSec: 60, path: "/", httpOnly: true, sameSite: "Lax" });
  expect(insecure).toContain("lh_sess=v");
  expect(insecure).toContain("HttpOnly");
  expect(insecure).toContain("SameSite=Lax");
  expect(insecure).toContain("Max-Age=60");
  expect(insecure).not.toContain("Secure");
  const secure = buildSetCookie("lh_sess", "v", { ttlSec: 60, path: "/", secure: true });
  expect(secure).toContain("Secure");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/session.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// auth/session.ts
import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "lh_sess";
export const OAUTH_COOKIE = "lh_oauth";

export interface SessionPayload {
  uid: string;
  name: string;
  exp: number;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64url(s: string): Buffer {
  let t = s.replace(/-/g, "+").replace(/_/g, "/");
  while (t.length % 4) t += "=";
  return Buffer.from(t, "base64");
}
function hmac(msg: string, secret: string): string {
  return b64url(createHmac("sha256", secret).update(msg).digest());
}

export function signToken(obj: Record<string, unknown>, secret: string): string {
  const payload = b64url(Buffer.from(JSON.stringify(obj), "utf8"));
  return payload + "." + hmac(payload, secret);
}

export function verifyToken<T = any>(token: string, secret: string, nowSec: number): T | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = hmac(payload, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let obj: any;
  try {
    obj = JSON.parse(fromB64url(payload).toString("utf8"));
  } catch {
    return null;
  }
  if (obj && typeof obj === "object" && typeof obj.exp === "number" && obj.exp < nowSec) return null;
  return obj as T;
}

export function signSession(p: SessionPayload, secret: string): string {
  return signToken(p as unknown as Record<string, unknown>, secret);
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

export function readSession(req: Request, secret: string, nowSec: number): SessionPayload | null {
  const cookies = parseCookies(req.headers.get("cookie"));
  const tok = cookies[SESSION_COOKIE];
  if (!tok) return null;
  const v = verifyToken<SessionPayload>(tok, secret, nowSec);
  if (!v || typeof v.uid !== "string") return null;
  return v;
}

export function buildSetCookie(
  name: string,
  value: string,
  opts: { ttlSec: number; path: string; secure?: boolean; httpOnly?: boolean; sameSite?: "Lax" | "Strict" | "None" },
): string {
  const bits = [`${name}=${value}`, `Path=${opts.path}`, `Max-Age=${opts.ttlSec}`];
  bits.push(`SameSite=${opts.sameSite ?? "Lax"}`);
  if (opts.httpOnly) bits.push("HttpOnly");
  if (opts.secure) bits.push("Secure");
  return bits.join("; ");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/session.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add auth/session.ts tests/unit/session.test.ts
git commit -m "auth: HMAC-signed stateless session + cookie helpers"
```

---

## Task 3: Gate decision module (`auth/gate.ts`)

**Files:**
- Create: `auth/gate.ts`
- Test: `tests/unit/gate.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/gate.test.ts
import { test, expect } from "bun:test";
import { sanitizeNext, apiTokenOk, humanAllowed, parsePublicMeta } from "../../auth/gate.ts";

test("sanitizeNext keeps safe relative paths", () => {
  expect(sanitizeNext("/pages/abc")).toBe("/pages/abc");
  expect(sanitizeNext("/pages/abc?x=1")).toBe("/pages/abc?x=1");
});

test("sanitizeNext rejects open-redirects", () => {
  expect(sanitizeNext("https://evil.com")).toBe("/");
  expect(sanitizeNext("//evil.com")).toBe("/");
  expect(sanitizeNext("http:/evil")).toBe("/");
  expect(sanitizeNext(null)).toBe("/");
  expect(sanitizeNext("not-relative")).toBe("/");
});

test("humanAllowed: gate off always allows", () => {
  expect(humanAllowed({ gateOn: false, isPublic: false, hasSession: false })).toBe(true);
});

test("humanAllowed: gate on requires session unless public", () => {
  expect(humanAllowed({ gateOn: true, isPublic: false, hasSession: false })).toBe(false);
  expect(humanAllowed({ gateOn: true, isPublic: false, hasSession: true })).toBe(true);
  expect(humanAllowed({ gateOn: true, isPublic: true, hasSession: false })).toBe(true);
});

test("apiTokenOk matches bearer, rejects others", () => {
  const ok = new Request("http://x/", { headers: { authorization: "Bearer s3cret" } });
  const bad = new Request("http://x/", { headers: { authorization: "Bearer nope" } });
  const none = new Request("http://x/");
  expect(apiTokenOk(ok, "s3cret")).toBe(true);
  expect(apiTokenOk(bad, "s3cret")).toBe(false);
  expect(apiTokenOk(none, "s3cret")).toBe(false);
});

test("parsePublicMeta reads public flag", () => {
  expect(parsePublicMeta({ public: "1" })).toBe(true);
  expect(parsePublicMeta({ "x-amz-meta-public": "1" })).toBe(true);
  expect(parsePublicMeta({ public: "0" })).toBe(false);
  expect(parsePublicMeta(undefined)).toBe(false);
  expect(parsePublicMeta({})).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/gate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// auth/gate.ts
import { timingSafeEqual } from "node:crypto";

// A safe same-origin destination: must start with a single "/" and not "//".
export function sanitizeNext(raw: string | null): string {
  if (!raw) return "/";
  if (!raw.startsWith("/")) return "/";
  if (raw.startsWith("//")) return "/";
  if (raw.includes("\\")) return "/";
  return raw;
}

export function apiTokenOk(req: Request, token: string): boolean {
  if (!token) return false;
  const h = req.headers.get("authorization") || "";
  const prefix = "Bearer ";
  if (!h.startsWith(prefix)) return false;
  const got = Buffer.from(h.slice(prefix.length));
  const want = Buffer.from(token);
  return got.length === want.length && timingSafeEqual(got, want);
}

export function humanAllowed(a: { gateOn: boolean; isPublic: boolean; hasSession: boolean }): boolean {
  if (!a.gateOn) return true;
  return a.isPublic || a.hasSession;
}

export function parsePublicMeta(metaData: Record<string, string> | undefined): boolean {
  if (!metaData) return false;
  return metaData.public === "1" || metaData["x-amz-meta-public"] === "1";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/gate.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add auth/gate.ts tests/unit/gate.test.ts
git commit -m "auth: pure gate decisions (next/api-token/human/public-meta)"
```

---

## Task 4: DingTalk client + org gate (`auth/dingtalk.ts`)

**Files:**
- Create: `auth/dingtalk.ts`
- Test: `tests/unit/dingtalk.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/dingtalk.test.ts
import { test, expect } from "bun:test";
import { createDingTalkClient } from "../../auth/dingtalk.ts";

const CFG = { clientId: "appkey", clientSecret: "appsecret", corpId: "" };

// Build a fake fetch routed by URL substring. Each entry returns a JSON body.
function fakeFetch(routes: Array<{ match: string; body: any; status?: number }>, calls: string[]) {
  return (async (input: any) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push(url);
    const r = routes.find((x) => url.includes(x.match));
    if (!r) throw new Error("no route for " + url);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

test("verifyAuthCode: member returns userId + name", async () => {
  const calls: string[] = [];
  const f = fakeFetch([
    { match: "userAccessToken", body: { accessToken: "USER", corpId: "c1" } },
    { match: "contact/users/me", body: { unionId: "UNION", nick: "nick" } },
    { match: "oauth2/accessToken", body: { accessToken: "APP", expireIn: 7200 } },
    { match: "getbyunionid", body: { errcode: 0, errmsg: "ok", result: { userid: "U123", contact_type: 0 } } },
    { match: "v2/user/get", body: { errcode: 0, result: { name: "张三", active: true, userid: "U123" } } },
  ], calls);
  const c = createDingTalkClient(CFG, f, () => 1000);
  const r = await c.verifyAuthCode("authcode");
  expect(r).toEqual({ ok: true, userId: "U123", name: "张三" });
});

test("verifyAuthCode: non-member (60121) rejected", async () => {
  const calls: string[] = [];
  const f = fakeFetch([
    { match: "userAccessToken", body: { accessToken: "USER" } },
    { match: "contact/users/me", body: { unionId: "UNION", nick: "nick" } },
    { match: "oauth2/accessToken", body: { accessToken: "APP", expireIn: 7200 } },
    { match: "getbyunionid", body: { errcode: 60121, errmsg: "找不到该用户" } },
  ], calls);
  const c = createDingTalkClient(CFG, f, () => 1000);
  expect(await c.verifyAuthCode("x")).toEqual({ ok: false, reason: "not_member" });
});

test("verifyAuthCode: other errcode is error, not reject", async () => {
  const f = fakeFetch([
    { match: "userAccessToken", body: { accessToken: "USER" } },
    { match: "contact/users/me", body: { unionId: "UNION" } },
    { match: "oauth2/accessToken", body: { accessToken: "APP", expireIn: 7200 } },
    { match: "getbyunionid", body: { errcode: 60011, errmsg: "no permission" } },
  ], []);
  const c = createDingTalkClient(CFG, f, () => 1000);
  expect(await c.verifyAuthCode("x")).toEqual({ ok: false, reason: "error" });
});

test("APP token is cached across calls", async () => {
  const calls: string[] = [];
  const f = fakeFetch([
    { match: "userAccessToken", body: { accessToken: "USER" } },
    { match: "contact/users/me", body: { unionId: "UNION" } },
    { match: "oauth2/accessToken", body: { accessToken: "APP", expireIn: 7200 } },
    { match: "getbyunionid", body: { errcode: 0, result: { userid: "U1" } } },
    { match: "v2/user/get", body: { errcode: 0, result: { name: "n" } } },
  ], calls);
  const c = createDingTalkClient(CFG, f, () => 1000);
  await c.verifyAuthCode("a");
  await c.verifyAuthCode("b");
  const appTokenCalls = calls.filter((u) => u.includes("oauth2/accessToken")).length;
  expect(appTokenCalls).toBe(1);
});

test("verifyAuthCode: network error is error", async () => {
  const f = (async () => { throw new Error("boom"); }) as unknown as typeof fetch;
  const c = createDingTalkClient(CFG, f, () => 1000);
  expect(await c.verifyAuthCode("x")).toEqual({ ok: false, reason: "error" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/dingtalk.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// auth/dingtalk.ts
//
// Modern unified DingTalk OAuth2 flow (NOT the legacy SNS endpoints).
// All calls are server->DingTalk (outbound). See the spec §7-§8 for the contract.
//
// NOTE: 60121 ("找不到该用户") is the documented "valid DingTalk account but not a
// member of this corp" signal. It was corroborated via a third-party errcode
// mirror, so it is a named constant — verify empirically with a non-member.

const NOT_MEMBER_ERRCODE = 60121;
const APP_TOKEN_SKEW_SEC = 300; // refresh 5 min before expiry

export type VerifyResult =
  | { ok: true; userId: string; name: string }
  | { ok: false; reason: "not_member" | "error" };

export interface DingTalkClient {
  verifyAuthCode(authCode: string): Promise<VerifyResult>;
}

export function createDingTalkClient(
  cfg: { clientId: string; clientSecret: string; corpId: string },
  fetchImpl: typeof fetch = fetch,
  clock: () => number = () => Math.floor(Date.now() / 1000),
): DingTalkClient {
  let appToken = "";
  let appTokenExp = 0;

  async function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<any> {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    return res.json();
  }

  async function getAppToken(): Promise<string> {
    const now = clock();
    if (appToken && now < appTokenExp - APP_TOKEN_SKEW_SEC) return appToken;
    const j = await postJson("https://api.dingtalk.com/v1.0/oauth2/accessToken", {
      appKey: cfg.clientId,
      appSecret: cfg.clientSecret,
    });
    if (!j.accessToken) throw new Error("app token fetch failed");
    appToken = j.accessToken;
    appTokenExp = now + (Number(j.expireIn) || 7200);
    return appToken;
  }

  async function verifyAuthCode(authCode: string): Promise<VerifyResult> {
    try {
      // Call 2 — exchange authCode -> USER token.
      const tok = await postJson("https://api.dingtalk.com/v1.0/oauth2/userAccessToken", {
        clientId: cfg.clientId,
        clientSecret: cfg.clientSecret,
        code: authCode,
        grantType: "authorization_code",
        refreshToken: "",
      });
      if (!tok.accessToken) return { ok: false, reason: "error" };
      if (cfg.corpId && tok.corpId && tok.corpId !== cfg.corpId) return { ok: false, reason: "not_member" };

      // Call 3 — USER token -> unionId.
      const meRes = await fetchImpl("https://api.dingtalk.com/v1.0/contact/users/me", {
        method: "GET",
        headers: { "x-acs-dingtalk-access-token": tok.accessToken, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(8000),
      });
      const me = await meRes.json();
      const unionId: string = me.unionId;
      if (!unionId) return { ok: false, reason: "error" };

      // Org gate — APP token -> getbyunionid.
      const app = await getAppToken();
      const byUnion = await postJson(
        `https://oapi.dingtalk.com/topapi/user/getbyunionid?access_token=${encodeURIComponent(app)}`,
        { unionid: unionId },
      );
      if (byUnion.errcode === NOT_MEMBER_ERRCODE) return { ok: false, reason: "not_member" };
      if (byUnion.errcode !== 0 || !byUnion.result?.userid) return { ok: false, reason: "error" };
      const userId: string = byUnion.result.userid;

      // Display name — v2/user/get.
      const detail = await postJson(
        `https://oapi.dingtalk.com/topapi/v2/user/get?access_token=${encodeURIComponent(app)}`,
        { userid: userId, language: "zh_CN" },
      );
      const name: string = (detail.errcode === 0 && detail.result?.name) || me.nick || userId;

      return { ok: true, userId, name };
    } catch {
      return { ok: false, reason: "error" };
    }
  }

  return { verifyAuthCode };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/dingtalk.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add auth/dingtalk.ts tests/unit/dingtalk.test.ts
git commit -m "auth: DingTalk OAuth2 client + cached app-token org gate"
```

---

## Task 5: Auth routes + server wiring + test-harness support

**Files:**
- Create: `auth/routes.ts`
- Modify: `server.ts` (imports ~1-5; config block after ~48; `/auth/*` dispatch after the OPTIONS handler ~427)
- Modify: `tests/_lib.sh` (symlink `auth/` in `start_server` and `restart_server`; add `mint_session`)
- Modify: `package.json` (add `test:unit`)
- Test: `tests/auth_routes.sh`

- [ ] **Step 1: Add `auth/` symlink + `mint_session` to `tests/_lib.sh`**

In `start_server`, after the existing `ln -s "$REPO_ROOT/skill" "$SERVER_RUNDIR/skill"` line, add:

```bash
  ln -s "$REPO_ROOT/auth" "$SERVER_RUNDIR/auth"
```

In `restart_server` there is no symlink block (it reuses `SERVER_RUNDIR`), so no change is needed there — but verify `restart_server` reuses the same `SERVER_RUNDIR` (it does). 

At the end of `_lib.sh` (after the `http()` helper), add a session-minting helper that mirrors `auth/session.ts` exactly (HMAC-SHA256 over the base64url payload):

```bash
# b64url <stdin> — base64url encode without padding.
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

# mint_session <uid> <name> <secret> — echo a valid lh_sess cookie value.
# Mirrors auth/session.ts: token = b64url(JSON) + "." + b64url(HMAC_SHA256(b64url(JSON))).
mint_session() {
  local json payload sig
  json="{\"uid\":\"$1\",\"name\":\"$2\",\"exp\":9999999999}"
  payload=$(printf '%s' "$json" | b64url)
  sig=$(printf '%s' "$payload" | openssl dgst -sha256 -hmac "$3" -binary | b64url)
  printf '%s.%s' "$payload" "$sig"
}
```

- [ ] **Step 2: Write the failing integration test**

```bash
# tests/auth_routes.sh
#!/usr/bin/env bash
# Auth routes when the DingTalk gate is ENABLED (no live DingTalk needed):
#   1. GET /auth/me without cookie -> {authenticated:false}
#   2. GET /auth/dingtalk/login -> 302 to login.dingtalk.com with our params + state cookie
#   3. GET /auth/me with a forged-but-valid lh_sess cookie -> authenticated identity
#   4. GET /auth/logout -> 302 and clears the cookie
set -uo pipefail
source "$(dirname "$0")/_lib.sh"

export DINGTALK_CLIENT_ID="testkey"
export DINGTALK_CLIENT_SECRET="testsecret"
export SESSION_SECRET="unit-secret"
start_server
BASE="http://127.0.0.1:$SERVER_PORT"

# 1. /auth/me anonymous
http GET "$BASE/auth/me"
assert_eq 200 "$HTTP_CODE" "me anon status"
case "$BODY" in *'"authenticated":false'*) pass "step 1: anon me" ;; *) fail "step1 body=$BODY" ;; esac

# 2. login redirect
LOGIN=$(curl -sS -i "$BASE/auth/dingtalk/login?next=%2Fpages%2Fabc")
echo "$LOGIN" | grep -qi "^location: https://login.dingtalk.com/oauth2/auth" || fail "step2 no authorize redirect: $LOGIN"
echo "$LOGIN" | grep -qi "client_id=testkey" || fail "step2 missing client_id"
echo "$LOGIN" | grep -qi "redirect_uri=" || fail "step2 missing redirect_uri"
echo "$LOGIN" | grep -qi "^set-cookie: lh_oauth=" || fail "step2 missing oauth state cookie"
pass "step 2: login 302 + state cookie"

# 3. forged valid session
SESS=$(mint_session "u42" "Tester" "$SESSION_SECRET")
http_with_cookie() { BODY=$(curl -sS -w "\n%{http_code}" --cookie "$1" "$2"); HTTP_CODE=$(printf '%s' "$BODY" | tail -n1); BODY=$(printf '%s' "$BODY" | sed '$d'); }
http_with_cookie "lh_sess=$SESS" "$BASE/auth/me"
assert_eq 200 "$HTTP_CODE" "me authed status"
case "$BODY" in *'"authenticated":true'*'"userId":"u42"'*) pass "step 3: authed me" ;; *) fail "step3 body=$BODY" ;; esac

# 4. logout
LOGOUT=$(curl -sS -i "$BASE/auth/logout")
echo "$LOGOUT" | grep -qi "^set-cookie: lh_sess=" || fail "step4 no clear cookie"
echo "$LOGOUT" | grep -qi "max-age=0" || fail "step4 cookie not expired"
pass "step 4: logout clears cookie"

echo "OK: auth routes"
```

Make it executable: `chmod +x tests/auth_routes.sh`.

- [ ] **Step 3: Run test to verify it fails**

Run: `bash tests/auth_routes.sh`
Expected: FAIL — `/auth/me` returns 404 (routes not wired yet).

- [ ] **Step 4: Write `auth/routes.ts`**

```ts
// auth/routes.ts
import type { AuthConfig } from "./config.ts";
import type { DingTalkClient } from "./dingtalk.ts";
import {
  signSession, signToken, verifyToken, parseCookies, buildSetCookie,
  readSession, SESSION_COOKIE, OAUTH_COOKIE,
} from "./session.ts";
import { sanitizeNext } from "./gate.ts";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, DELETE, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function originOf(cfg: AuthConfig, url: URL): string {
  return cfg.baseUrl || `${url.protocol}//${url.host}`;
}
function isSecure(cfg: AuthConfig, url: URL): boolean {
  return originOf(cfg, url).startsWith("https:");
}
function htmlError(msg: string, status: number, extraSetCookie?: string): Response {
  const h = new Headers({ ...CORS, "Content-Type": "text/html; charset=utf-8" });
  if (extraSetCookie) h.append("Set-Cookie", extraSetCookie);
  const body = `<!doctype html><meta charset="utf-8"><title>登录</title>
<body style="font:15px/1.6 -apple-system,sans-serif;max-width:520px;margin:80px auto;text-align:center;color:#222">
<p style="font-size:18px">${msg}</p>
<p><a href="/auth/dingtalk/login" style="color:#2563eb">重新登录</a></p></body>`;
  return new Response(body, { status, headers: h });
}

export async function handleAuthRoute(
  req: Request,
  url: URL,
  cfg: AuthConfig,
  client: DingTalkClient | null,
  nowSec: number,
): Promise<Response | null> {
  const path = url.pathname;

  if (path === "/auth/me") {
    const sess = cfg.dingtalkEnabled ? readSession(req, cfg.sessionSecret, nowSec) : null;
    return Response.json(
      sess ? { authenticated: true, userId: sess.uid, name: sess.name } : { authenticated: false },
      { headers: CORS },
    );
  }

  if (path === "/auth/logout") {
    const h = new Headers({ ...CORS, Location: sanitizeNext(url.searchParams.get("next")) });
    h.append("Set-Cookie", buildSetCookie(SESSION_COOKIE, "", { ttlSec: 0, path: "/" }));
    return new Response(null, { status: 302, headers: h });
  }

  if (path === "/auth/dingtalk/login") {
    if (!cfg.dingtalkEnabled) return new Response("auth not configured", { status: 404, headers: CORS });
    const next = sanitizeNext(url.searchParams.get("next"));
    const state = crypto.randomUUID();
    const stateTok = signToken({ s: state, n: next, exp: nowSec + 600 }, cfg.sessionSecret);
    const redirectUri = `${originOf(cfg, url)}/auth/dingtalk/callback`;
    const authorize =
      "https://login.dingtalk.com/oauth2/auth" +
      `?redirect_uri=${encodeURIComponent(redirectUri)}` +
      "&response_type=code" +
      `&client_id=${encodeURIComponent(cfg.clientId)}` +
      "&scope=openid%20corpid" +
      `&state=${encodeURIComponent(state)}` +
      "&prompt=consent";
    const h = new Headers({ ...CORS, Location: authorize });
    h.append(
      "Set-Cookie",
      buildSetCookie(OAUTH_COOKIE, stateTok, { ttlSec: 600, path: "/auth", httpOnly: true, secure: isSecure(cfg, url) }),
    );
    return new Response(null, { status: 302, headers: h });
  }

  if (path === "/auth/dingtalk/callback") {
    if (!cfg.dingtalkEnabled || !client) return new Response("auth not configured", { status: 404, headers: CORS });
    const code = url.searchParams.get("authCode") || url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const cookies = parseCookies(req.headers.get("cookie"));
    const blob = verifyToken<{ s: string; n: string }>(cookies[OAUTH_COOKIE] ?? "", cfg.sessionSecret, nowSec);
    const clearState = buildSetCookie(OAUTH_COOKIE, "", { ttlSec: 0, path: "/auth" });
    if (!code || !state || !blob || blob.s !== state) return htmlError("登录校验失败，请重试", 400, clearState);

    const result = await client.verifyAuthCode(code);
    if (!result.ok) {
      if (result.reason === "not_member") return htmlError("你不是该企业成员，无法访问。", 403, clearState);
      return htmlError("登录失败，请稍后重试", 502, clearState);
    }
    const sess = signSession({ uid: result.userId, name: result.name, exp: nowSec + cfg.sessionTtlSec }, cfg.sessionSecret);
    const h = new Headers({ ...CORS, Location: sanitizeNext(blob.n) });
    h.append("Set-Cookie", clearState);
    h.append(
      "Set-Cookie",
      buildSetCookie(SESSION_COOKIE, sess, { ttlSec: cfg.sessionTtlSec, path: "/", httpOnly: true, secure: isSecure(cfg, url) }),
    );
    return new Response(null, { status: 302, headers: h });
  }

  return null;
}
```

- [ ] **Step 5: Wire config + dispatch into `server.ts`**

Add imports at the top (after the existing `minio` import, ~line 5):

```ts
import { loadAuthConfig } from "./auth/config.ts";
import { createDingTalkClient } from "./auth/dingtalk.ts";
import { handleAuthRoute } from "./auth/routes.ts";
import { readSession, parseCookies } from "./auth/session.ts";
import { apiTokenOk, humanAllowed, parsePublicMeta, sanitizeNext } from "./auth/gate.ts";
```

After the MinIO init block (after line ~48, before `type RoomState`), add:

```ts
// ---- Auth (optional; both gates off => unchanged behavior) ----
const authCfg = loadAuthConfig(process.env as Record<string, string | undefined>);
const ding = authCfg.dingtalkEnabled
  ? createDingTalkClient({ clientId: authCfg.clientId, clientSecret: authCfg.clientSecret, corpId: authCfg.corpId })
  : null;
const nowSec = () => Math.floor(Date.now() / 1000);
if (authCfg.dingtalkEnabled) console.log(`[auth] DingTalk login gate ENABLED`);
if (authCfg.apiTokenEnabled) console.log(`[auth] API token gate ENABLED`);

// Per-page public flag cache (source of truth = MinIO object metadata).
const publicCache = new Map<string, boolean>();
async function isPublicPage(key: string): Promise<boolean> {
  if (!minio) return false;
  if (publicCache.has(key)) return publicCache.get(key)!;
  try {
    const st: any = await minio.statObject(MINIO_BUCKET, key);
    const pub = parsePublicMeta(st?.metaData);
    publicCache.set(key, pub);
    return pub;
  } catch {
    return false;
  }
}
function apiGateFail(req: Request): Response | null {
  if (!authCfg.apiTokenEnabled) return null;
  if (apiTokenOk(req, authCfg.apiToken)) return null;
  return new Response("unauthorized", { status: 401, headers: { ...CORS, "WWW-Authenticate": "Bearer" } });
}
```

In the `fetch` handler, immediately after the `if (req.method === "OPTIONS") return ...` line (~line 427), add:

```ts
    if (path.startsWith("/auth/")) {
      const r = await handleAuthRoute(req, url, authCfg, ding, nowSec());
      if (r) return r;
    }
```

- [ ] **Step 6: Add `test:unit` script to `package.json`**

In the `"scripts"` block, add:

```json
    "test:unit": "bun test tests/unit",
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `bun test tests/unit && bash tests/auth_routes.sh`
Expected: all unit tests PASS; `OK: auth routes`.
Also run a regression of an existing test: `bash tests/v1_state_alias.sh` → still `OK` (proves `_lib.sh` symlink change didn't break the harness).

- [ ] **Step 8: Commit**

```bash
git add auth/routes.ts server.ts tests/_lib.sh tests/auth_routes.sh package.json
git commit -m "auth: /auth/* routes (login/callback/logout/me) wired into server"
```

---

## Task 6: Human gate on `GET /pages/<key>` (HTML)

**Files:**
- Modify: `server.ts` — the `GET` arm inside `if (path.startsWith("/pages/"))`, specifically the `if (req.method === "GET")` block at ~line 636.
- Test: `tests/auth_human_gate.sh`

- [ ] **Step 1: Write the failing test**

```bash
# tests/auth_human_gate.sh
#!/usr/bin/env bash
# With the DingTalk gate ON (MinIO absent in tests, so we only assert the GATE,
# which runs BEFORE MinIO):
#   1. GET /pages/<key> with no session -> 302 to /auth/dingtalk/login?next=...
#   2. GET /pages/<key> with a valid forged session -> NOT 302 (gate passed;
#      then 503 because MinIO is unconfigured in tests).
set -uo pipefail
source "$(dirname "$0")/_lib.sh"

export DINGTALK_CLIENT_ID="testkey"
export DINGTALK_CLIENT_SECRET="testsecret"
export SESSION_SECRET="unit-secret"
start_server
BASE="http://127.0.0.1:$SERVER_PORT"

# 1. anonymous -> redirect to login
R=$(curl -sS -i "$BASE/pages/secret-doc")
echo "$R" | grep -qiE "^HTTP/[0-9.]+ 302" || fail "step1 expected 302, got: $(echo "$R" | head -1)"
echo "$R" | grep -qi "^location: /auth/dingtalk/login?next=" || fail "step1 wrong location: $R"
pass "step 1: anon page GET -> 302 login"

# 2. valid session -> gate passes (MinIO missing => 503, NOT a 302 login)
SESS=$(mint_session "u1" "T" "$SESSION_SECRET")
CODE=$(curl -sS -o /dev/null -w "%{http_code}" --cookie "lh_sess=$SESS" "$BASE/pages/secret-doc")
[ "$CODE" != "302" ] || fail "step2 still redirected with valid session"
assert_eq 503 "$CODE" "step2 expected 503 (no minio) after gate, got $CODE"
pass "step 2: authed page GET passes gate (503 from missing minio)"

echo "OK: human page gate"
```

`chmod +x tests/auth_human_gate.sh`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bash tests/auth_human_gate.sh`
Expected: FAIL at step 1 — currently returns 503 (no gate), not 302.

- [ ] **Step 3: Add the gate to the GET arm**

In `server.ts`, find the GET arm at ~line 636:

```ts
      if (req.method === "GET") {
        try {
          const data = await streamMinioObject(key);
```

Insert the gate immediately inside `if (req.method === "GET") {`, before `try {`:

```ts
      if (req.method === "GET") {
        if (authCfg.dingtalkEnabled) {
          const isPub = await isPublicPage(key);
          const hasSession = !!readSession(req, authCfg.sessionSecret, nowSec());
          if (!humanAllowed({ gateOn: true, isPublic: isPub, hasSession })) {
            const loc = `/auth/dingtalk/login?next=${encodeURIComponent(path)}`;
            return new Response(null, { status: 302, headers: { ...CORS, Location: loc } });
          }
        }
        try {
          const data = await streamMinioObject(key);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash tests/auth_human_gate.sh`
Expected: `OK: human page gate`.
Regression: `bash tests/v1_state_alias.sh` (state alias path is unaffected) → `OK`.

- [ ] **Step 5: Commit**

```bash
git add server.ts tests/auth_human_gate.sh
git commit -m "auth: DingTalk session gate on GET /pages/<key> HTML"
```

---

## Task 7: WebSocket gate + identity propagation

**Files:**
- Modify: `server.ts` — `/ws` upgrade (~line 420-425), `WsData`/`Peer` type (~line 51-52), `hi` handler (~line 694-716), `set`/`del` `by` (~line 720-738), `presenceList` (uses `peer.user`).
- Test: `tests/unit/gate.test.ts` (extend), `tests/auth_ws_gate.sh`

- [ ] **Step 1: Extend the unit test for the WS room decision**

The WS `hi` decision reuses `humanAllowed` plus a room→key mapping. Add to `tests/unit/gate.test.ts`:

```ts
import { roomPublicKey } from "../../auth/gate.ts";

test("roomPublicKey extracts page key from pages/ rooms only", () => {
  expect(roomPublicKey("pages/abc")).toBe("abc");
  expect(roomPublicKey("pages/team/q3")).toBe("team/q3");
  expect(roomPublicKey("default")).toBeNull();
  expect(roomPublicKey("examples/demo.html")).toBeNull();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/unit/gate.test.ts`
Expected: FAIL — `roomPublicKey` not exported.

- [ ] **Step 3: Add `roomPublicKey` to `auth/gate.ts`**

```ts
// Maps a room id to the page key whose public-flag governs it, or null if the
// room is not page-backed (those are deny-by-default when the gate is on).
export function roomPublicKey(room: string): string | null {
  if (room === "pages" || room === "pages/") return null;
  if (room.startsWith("pages/")) return room.slice("pages/".length);
  return null;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/unit/gate.test.ts`
Expected: PASS.

- [ ] **Step 5: Thread verified identity through the WS upgrade**

In `server.ts`, change the `Peer` type (~line 51) to carry auth:

```ts
type Peer = { id: string; room: string; user: unknown; auth: { uid: string; name: string } | null };
```

Change the `/ws` upgrade (~line 420-424) to read+verify the session cookie at handshake time and attach it:

```ts
    if (path === "/ws") {
      const sess = authCfg.dingtalkEnabled ? readSession(req, authCfg.sessionSecret, nowSec()) : null;
      const ok = srv.upgrade(req, {
        data: {
          peer: {
            id: crypto.randomUUID(),
            room: "",
            user: null,
            auth: sess ? { uid: sess.uid, name: sess.name } : null,
          },
        } satisfies WsData,
      });
      return ok ? undefined : new Response("upgrade failed", { status: 400 });
    }
```

- [ ] **Step 6: Enforce the gate in the `hi` handler and use trusted identity**

In the websocket `message` handler, replace the `if (msg.t === "hi")` block (~line 694-716) with:

```ts
      if (msg.t === "hi") {
        const room = sanitizeRoom(msg.room || "default");

        // DingTalk gate: when on, a browser needs a session unless the room is
        // backed by a public page. Non-page rooms are deny-by-default.
        if (authCfg.dingtalkEnabled && !peer.auth) {
          const key = roomPublicKey(room);
          const isPub = key ? await isPublicPage(key) : false;
          if (!humanAllowed({ gateOn: true, isPublic: isPub, hasSession: false })) {
            ws.send(JSON.stringify({ t: "denied", reason: "login_required" }));
            ws.close();
            return;
          }
        }

        peer.room = room;
        // Trusted identity overrides any client-supplied user/clientId.
        if (peer.auth) {
          peer.user = { name: peer.auth.name, userId: peer.auth.uid };
          peer.id = peer.auth.uid;
        } else {
          peer.user = msg.user ?? null;
          if (typeof msg.clientId === "string" && msg.clientId.length <= 64) {
            peer.id = msg.clientId;
          }
        }
        const set = peersByRoom.get(room) ?? new Set<ServerWebSocket<WsData>>();
        set.add(ws);
        peersByRoom.set(room, set);
        const state = await loadRoom(room);
        ws.send(JSON.stringify({ t: "init", room, state, peers: presenceList(room), you: peer.id }));
        broadcast(room, { t: "pres", peers: presenceList(room) }, ws);
        return;
      }
```

Note: `set`/`del`/`pres` handlers already use `peer.id`/`peer.user`, which are now the trusted values when authenticated — `by` becomes the verified `uid` automatically. No change needed there.

- [ ] **Step 7: Write the WS integration test (uses Bun's WebSocket client)**

```bash
# tests/auth_ws_gate.sh
#!/usr/bin/env bash
# WS hi-time gate when DingTalk gate is ON:
#   1. hi for a protected (non-page / private) room with NO session cookie -> "denied"
#   2. hi with a valid session cookie -> "init" (allowed) and `you` == uid
set -uo pipefail
source "$(dirname "$0")/_lib.sh"

export DINGTALK_CLIENT_ID="testkey"
export DINGTALK_CLIENT_SECRET="testsecret"
export SESSION_SECRET="unit-secret"
start_server
BASE_WS="ws://127.0.0.1:$SERVER_PORT/ws"
SESS=$(mint_session "u7" "Seven" "$SESSION_SECRET")

# Bun WS client: connect, optionally send a Cookie header, send hi, print first frame.
ws_first_frame() {  # $1 cookie-or-empty
  COOKIE="$1" WS="$BASE_WS" bun -e '
    const headers = process.env.COOKIE ? { Cookie: process.env.COOKIE } : {};
    const ws = new WebSocket(process.env.WS, { headers });
    const done = (s) => { try { ws.close(); } catch {} console.log(s); process.exit(0); };
    ws.addEventListener("open", () => ws.send(JSON.stringify({ t: "hi", room: "pages/secret" })));
    ws.addEventListener("message", (e) => done(String(e.data)));
    ws.addEventListener("close", () => done("CLOSED"));
    setTimeout(() => done("TIMEOUT"), 4000);
  '
}

OUT_ANON=$(ws_first_frame "")
case "$OUT_ANON" in *'"t":"denied"'*|CLOSED) pass "step 1: anon WS denied ($OUT_ANON)" ;; *) fail "step1 expected denied, got: $OUT_ANON" ;; esac

OUT_AUTH=$(ws_first_frame "lh_sess=$SESS")
case "$OUT_AUTH" in *'"t":"init"'*'"you":"u7"'*) pass "step 2: authed WS init with trusted you=u7" ;; *) fail "step2 expected init you=u7, got: $OUT_AUTH" ;; esac

echo "OK: ws gate"
```

`chmod +x tests/auth_ws_gate.sh`.

> If Bun's `WebSocket` client rejects the `headers` option in the installed Bun version, fall back to asserting only step 1 via the deny path using a query (skip step 2) and cover identity via the unit test + manual smoke; note any such adjustment in the commit message.

- [ ] **Step 8: Run tests**

Run: `bun test tests/unit/gate.test.ts && bash tests/auth_ws_gate.sh`
Expected: unit PASS; `OK: ws gate`.
Regression: `bash tests/v3_longpoll_concurrency.sh` (WS unaffected by long-poll) and `bash tests/v_demo_smoke.sh` if present → `OK`.

- [ ] **Step 9: Commit**

```bash
git add server.ts auth/gate.ts tests/unit/gate.test.ts tests/auth_ws_gate.sh
git commit -m "auth: WS hi-time gate + trusted identity for presence/by"
```

---

## Task 8: API-token gate on agent surfaces

**Files:**
- Modify: `server.ts` — insert `apiGateFail` at the start of each agent branch: `/rooms` (~572), `/pages` list (~584), `/pages/<key>/state` sub-branch (~606), `/pages/<key>` PUT (~626) and DELETE (~653), `/state/` (~674).
- Test: `tests/auth_api_token.sh`

- [ ] **Step 1: Write the failing test**

```bash
# tests/auth_api_token.sh
#!/usr/bin/env bash
# With LIVEHTML_API_TOKEN set, agent/state HTTP surfaces require the bearer.
# Human/open surfaces stay open. (No MinIO needed: uses /state + /pages/<k>/state.)
set -uo pipefail
source "$(dirname "$0")/_lib.sh"

export LIVEHTML_API_TOKEN="tok-123"
start_server
BASE="http://127.0.0.1:$SERVER_PORT"

# state alias GET without token -> 401
CODE=$(curl -sS -o /dev/null -w "%{http_code}" "$BASE/pages/k1/state")
assert_eq 401 "$CODE" "state GET without token should be 401"

# with token -> 200
CODE=$(curl -sS -o /dev/null -w "%{http_code}" -H "Authorization: Bearer tok-123" "$BASE/pages/k1/state")
assert_eq 200 "$CODE" "state GET with token should be 200"

# /state/<room> PUT without token -> 401
CODE=$(curl -sS -o /dev/null -w "%{http_code}" -X PUT -H "Content-Type: application/json" --data '{"a":1}' "$BASE/state/room1")
assert_eq 401 "$CODE" "state PUT without token should be 401"

# /rooms without token -> 401
CODE=$(curl -sS -o /dev/null -w "%{http_code}" "$BASE/rooms")
assert_eq 401 "$CODE" "/rooms without token should be 401"

# open surface stays open: landing page
CODE=$(curl -sS -o /dev/null -w "%{http_code}" "$BASE/")
assert_eq 200 "$CODE" "landing page should stay open"

# /sync.js stays open
CODE=$(curl -sS -o /dev/null -w "%{http_code}" "$BASE/sync.js")
assert_eq 200 "$CODE" "/sync.js should stay open"

pass "all api-token assertions held"
echo "OK: api token gate"
```

`chmod +x tests/auth_api_token.sh`.

- [ ] **Step 2: Run to verify it fails**

Run: `bash tests/auth_api_token.sh`
Expected: FAIL — state GET returns 200 without token (no gate yet).

- [ ] **Step 3: Insert `apiGateFail` guards**

Add `const g = apiGateFail(req); if (g) return g;` as the first line inside each of these branches in `server.ts`:

1. `/rooms` branch — inside `if (path === "/rooms" && req.method === "GET") {`:

```ts
    if (path === "/rooms" && req.method === "GET") {
      const g = apiGateFail(req); if (g) return g;
```

2. `/pages` list branch — inside `if (path === "/pages" || path === "/pages/") {`, after the `if (!minio) ...` / before listing (put it first):

```ts
    if (path === "/pages" || path === "/pages/") {
      const g = apiGateFail(req); if (g) return g;
      if (!minio) return errResp("minio not configured", 503);
```

3. `/pages/<key>/state` sub-branch — inside `if (rest.endsWith("/state")) {`, first line:

```ts
      if (rest.endsWith("/state")) {
        const g = apiGateFail(req); if (g) return g;
        const rawKey = rest.slice(0, -"/state".length);
```

4. `/pages/<key>` PUT arm — inside `if (req.method === "PUT") {` (the HTML upload, ~626):

```ts
      if (req.method === "PUT") {
        const g = apiGateFail(req); if (g) return g;
        const body = await readBodyToBuffer(req);
```

5. `/pages/<key>` DELETE arm — inside `if (req.method === "DELETE") {` (~653):

```ts
      if (req.method === "DELETE") {
        const g = apiGateFail(req); if (g) return g;
        try {
          await minio.removeObject(MINIO_BUCKET, key);
```

6. `/state/` branch — inside `if (path.startsWith("/state/")) {` (~674):

```ts
    if (path.startsWith("/state/")) {
      const g = apiGateFail(req); if (g) return g;
      const raw = decodeURIComponent(path.slice("/state/".length));
```

Note: the GET arm of `/pages/<key>` (HTML) is intentionally **not** token-gated — it is the human surface (DingTalk-gated in Task 6).

- [ ] **Step 4: Run to verify it passes**

Run: `bash tests/auth_api_token.sh`
Expected: `OK: api token gate`.
Regression (token OFF = open as before): `bash tests/v1_state_alias.sh && bash tests/c1_envelope_format.sh` → `OK` (these run without `LIVEHTML_API_TOKEN`).

- [ ] **Step 5: Commit**

```bash
git add server.ts tests/auth_api_token.sh
git commit -m "auth: API-token gate on agent state/upload surfaces"
```

---

## Task 9: `X-Public` upload + public-flag persistence

**Files:**
- Modify: `server.ts` — PUT `/pages/<key>` arm (~626-634; set MinIO metadata + `publicCache`), DELETE arm (~653-669; clear `publicCache`).

(Public end-to-end serving requires MinIO, so it is verified by manual smoke in Task 13. The pure parser `parsePublicMeta` is already unit-tested in Task 3; the cache wiring is small and exercised by smoke.)

- [ ] **Step 1: Set object metadata + cache on PUT**

In the PUT arm, replace the `putObject` call (~629) so it records the public flag:

```ts
      if (req.method === "PUT") {
        const g = apiGateFail(req); if (g) return g;
        const body = await readBodyToBuffer(req);
        if (!body) return errResp(`body must be non-empty and ≤ ${MAX_HTML_SIZE} bytes`, 400);
        const isPub = /^(1|true|yes)$/i.test(req.headers.get("x-public") || "");
        await minio.putObject(MINIO_BUCKET, key, body, body.length, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache",
          public: isPub ? "1" : "0",
        });
        publicCache.set(key, isPub);
        return jsonResp({ ok: true, key, url: `/pages/${key}`, room: roomForPageKey(key), public: isPub });
      }
```

- [ ] **Step 2: Clear cache on DELETE**

In the DELETE arm, after `rooms.delete(room); metaByRoom.delete(room);` (~663-664), add:

```ts
        publicCache.delete(key);
```

- [ ] **Step 3: Type-check / boot**

Run: `bun --eval "await import('./server.ts')" 2>&1 | head -5` is not viable (it binds a port). Instead just smoke-start:
Run: `PORT=0 timeout 2 bun server.ts; echo "exit=$?"` — Expected: starts and prints the listening line (timeout kills it). No type errors.

(Alternatively `bunx tsc --noEmit` if a tsconfig lib is set; the repo uses `@types/bun`.)

- [ ] **Step 4: Commit**

```bash
git add server.ts
git commit -m "auth: X-Public upload header -> MinIO metadata + public-flag cache"
```

---

## Task 10: Client identity in `public/sync.js`

**Files:**
- Modify: `public/sync.js` — `start()` (~420), `loadUser()` usage, presence rename affordance (~369-382), add `denied` handling in `ws.onmessage` (~247-268).

(Client JS has no test harness in this repo; verified by manual smoke in Task 13. Changes are additive and must not break the unauthenticated path.)

- [ ] **Step 1: Fetch `/auth/me` before connecting and apply identity**

In `sync.js`, change `start()` (~line 420) to fetch identity first:

```js
  function start() {
    buildChip();
    scanAndBind(document);
    observeDom();
    // If the deployment requires login, /auth/me returns the verified identity.
    fetch("/auth/me", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((me) => {
        if (me && me.authenticated && me.name) {
          user = { name: me.name, userId: me.userId };
          authedIdentity = true;
        }
      })
      .catch(() => {})
      .finally(() => {
        updateChip();
        connect();
      });
  }
```

Add a module-level flag near the other state vars (~line 149):

```js
  let authedIdentity = false;
```

Extract the existing MutationObserver setup (currently inline in `start()`, ~line 423-439) into a helper `observeDom()` so `start()` reads cleanly:

```js
  function observeDom() {
    const obs = new MutationObserver((muts) => {
      for (const m of muts) {
        m.addedNodes.forEach((n) => {
          if (n.nodeType === 1) scanAndBind(n);
        });
        if (m.type === "attributes" && m.target.hasAttribute("data-live")) {
          bind(m.target);
        }
      }
    });
    obs.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-live"],
    });
  }
```

(Remove the old inline `const obs = ...; obs.observe(...)` and the old `connect();` call from `start()` — they are now in `observeDom()` and the `.finally()` above.)

- [ ] **Step 2: Hide the rename affordance when authenticated**

In `renderPanel()` (~line 369), guard the rename click wiring with `!authedIdentity`:

```js
      if (p.id === myId) {
        name.textContent += " (你)";
        if (!authedIdentity) {
          name.style.cursor = "pointer";
          name.title = "点击改名";
          name.addEventListener("click", (e) => {
            e.stopPropagation();
            const newName = prompt("修改昵称", user.name || "");
            if (newName && newName.trim()) {
              user = { ...user, name: newName.trim() };
              saveUserName(user.name);
              sendMsg({ t: "pres", v: user });
              updateChip();
            }
          });
        }
      }
```

- [ ] **Step 3: Handle a `denied` frame (stop reconnect storm, show login link)**

In `ws.onmessage`'s `switch (msg.t)` (~line 247), add a case:

```js
        case "denied":
          deniedLogin = true;
          try { ws.close(); } catch {}
          showLoginNeeded();
          break;
```

Add near the state vars:

```js
  let deniedLogin = false;
```

In `ws.onclose` (~line 270), do not reconnect if denied:

```js
    ws.onclose = () => {
      connected = false;
      updateChip();
      if (deniedLogin) return; // login required — stop hammering
      const delay = Math.min(backoff, 8000) + Math.random() * 500;
      backoff = Math.min(backoff * 2, 8000);
      setTimeout(connect, delay);
    };
```

Add the `showLoginNeeded` helper (near `buildChip`, ~line 288):

```js
  function showLoginNeeded() {
    if (chipCount) chipCount.textContent = "需要登录";
    if (chipDot) chipDot.style.background = "#ef4444";
    const next = encodeURIComponent(location.pathname + location.search);
    const a = document.createElement("a");
    a.href = "/auth/dingtalk/login?next=" + next;
    a.textContent = "点此登录";
    a.style.cssText = "margin-left:8px;color:#2563eb;text-decoration:underline";
    if (chip) chip.appendChild(a);
  }
```

- [ ] **Step 4: Sanity-check syntax**

Run: `bun -e "new Function(require('fs').readFileSync('public/sync.js','utf8')); console.log('sync.js parses')"`
Expected: `sync.js parses` (no SyntaxError).

- [ ] **Step 5: Commit**

```bash
git add public/sync.js
git commit -m "client: use verified DingTalk identity, hide rename, handle denied"
```

---

## Task 11: Deployment surfaces (Dockerfile, .env.example, docker-compose)

**Files:**
- Modify: `Dockerfile` (add `COPY auth ./auth`), `.env.example`, `docker-compose.yml`.

- [ ] **Step 1: Copy `auth/` into the image**

In `Dockerfile`, after `COPY server.ts ./` add:

```dockerfile
COPY auth ./auth
```

- [ ] **Step 2: Document new env vars in `.env.example`**

Append to `.env.example`:

```bash

# ---- Optional DingTalk login gate (leave blank to disable) ----
# Setting DINGTALK_CLIENT_ID turns the human login gate ON for /pages/*.
DINGTALK_CLIENT_ID=
DINGTALK_CLIENT_SECRET=
# Optional soft cross-check against the corp the user logs into.
DINGTALK_CORP_ID=
# Stable external origin used to build the exact-match OAuth redirect_uri.
# Must equal the callback you register in the DingTalk console (登录与分享).
LIVEHTML_PUBLIC_BASE_URL=http://192.168.130.12:39191
# Required when the DingTalk gate is on. Use a long random string.
SESSION_SECRET=
# Session lifetime in seconds (default 604800 = 7 days).
SESSION_TTL_SEC=604800

# ---- Optional API token gate for agent/read-back HTTP surfaces ----
# Setting this requires `Authorization: Bearer <token>` on state/upload calls.
LIVEHTML_API_TOKEN=
```

- [ ] **Step 3: Pass the vars through `docker-compose.yml`**

In the `livehtml` service `environment:` block, add (placeholders read from `.env`):

```yaml
      DINGTALK_CLIENT_ID: ${DINGTALK_CLIENT_ID:-}
      DINGTALK_CLIENT_SECRET: ${DINGTALK_CLIENT_SECRET:-}
      DINGTALK_CORP_ID: ${DINGTALK_CORP_ID:-}
      LIVEHTML_PUBLIC_BASE_URL: ${LIVEHTML_PUBLIC_BASE_URL:-}
      SESSION_SECRET: ${SESSION_SECRET:-}
      SESSION_TTL_SEC: ${SESSION_TTL_SEC:-604800}
      LIVEHTML_API_TOKEN: ${LIVEHTML_API_TOKEN:-}
```

(Outbound internet to `*.dingtalk.com` is available on the default compose bridge network — no extra config; note it in README in Task 13.)

- [ ] **Step 4: Verify compose parses**

Run: `docker compose config >/dev/null && echo "compose ok"`
Expected: `compose ok`.

- [ ] **Step 5: Commit**

```bash
git add Dockerfile .env.example docker-compose.yml
git commit -m "deploy: ship auth/ in image; document DingTalk + API-token env"
```

---

## Task 12: Skill + installer — API token + `X-Public`

**Files:**
- Modify: `skill/SKILL.md` (agent-facing docs), `scripts/install-skill.cjs` + the server-generated `/install` and `/install.ps1` (store API token next to base-url).

- [ ] **Step 1: Document the API token + `X-Public` in `skill/SKILL.md`**

Add a short section (near the existing base-URL/read-back cookbooks) — exact prose:

```markdown
## 受保护部署（可选）

若部署启用了登录/令牌保护：

- **Agent 调用带令牌**：从 `~/.local/state/livehtml/api-token`（若存在）读取令牌，并在所有 `PUT /pages/<key>`、`GET/PUT/DELETE /pages/<key>/state`、`/state/<room>`、`/rooms` 请求上加头：
  `Authorization: Bearer <token>`
  未配置令牌的部署无需此头（向后兼容）。
- **公开某个页面**（免登浏览）：上传时加头 `X-Public: 1`：
  `curl -fsS -X PUT -H "X-Public: 1" --data-binary @page.html "$BASE/pages/<key>"`
  默认（不带该头）页面为受保护，需钉钉登录后才能查看。
- **人类查看者**：受保护页面在浏览器打开时会跳转钉钉扫码登录，仅本企业成员可访问；`by`/在线名单显示其真实姓名。生成的 HTML 无需任何改动。
```

- [ ] **Step 2: Store an API token in the POSIX installer (`/install`) and `install-skill.cjs`**

In `server.ts`'s `/install` script string, after the base-URL write block, add an optional token capture (the operator pipes `LIVEHTML_API_TOKEN=... | sh` or is prompted). Keep it non-interactive and additive:

```sh
if [ -n "${LIVEHTML_API_TOKEN:-}" ]; then
  printf '%s' "$LIVEHTML_API_TOKEN" > "$STATE_DIR/api-token"
  echo "✓ api token → $STATE_DIR/api-token"
fi
```

In `/install.ps1`, after the base-URL write:

```powershell
if ($env:LIVEHTML_API_TOKEN) {
  [System.IO.File]::WriteAllText((Join-Path $StateDir 'api-token'), $env:LIVEHTML_API_TOKEN)
  Write-Host "[ok] api token -> $StateDir/api-token"
}
```

In `scripts/install-skill.cjs`, if it writes the base-url file, mirror the same optional `api-token` write from `process.env.LIVEHTML_API_TOKEN` (locate the base-url write and add the conditional next to it; if `install-skill.cjs` does not write base-url, skip — note this in the commit).

- [ ] **Step 3: Smoke the generated installer text**

Run: `PORT=0 timeout 2 bun server.ts & sleep 1; PORT_PID=$!; true` is fragile; instead start on a fixed port and curl:
```bash
PORT=39777 bun server.ts >/tmp/lh.log 2>&1 &
SVPID=$!; sleep 1
curl -fsS http://127.0.0.1:39777/install | grep -q "api-token" && echo "install has api-token block"
kill $SVPID
```
Expected: `install has api-token block`.

- [ ] **Step 4: Commit**

```bash
git add skill/SKILL.md server.ts scripts/install-skill.cjs
git commit -m "skill: document API token + X-Public; installer stores api-token"
```

---

## Task 13: README, full regression, manual smoke checklist

**Files:**
- Modify: `README.md`.

- [ ] **Step 1: Add an auth section to `README.md`**

Add a section documenting: the two gates and how to enable them; the deploy action items from spec §15 (register the callback verbatim in 登录与分享; **verify the console accepts `http://`**; grant contact read permission; ensure outbound egress to `*.dingtalk.com`); the `X-Public: 1` upload; and that generated HTML is unchanged. (Write the section to match the README's existing zh tone; reference `docs/superpowers/specs/2026-05-29-dingtalk-oauth-login-design.md`.)

- [ ] **Step 2: Run the full unit + shell regression**

```bash
bun test tests/unit
for t in tests/auth_routes.sh tests/auth_human_gate.sh tests/auth_ws_gate.sh tests/auth_api_token.sh \
         tests/v1_state_alias.sh tests/v1_longpoll_changed.sh tests/v2_longpoll_not_modified.sh \
         tests/v3_longpoll_concurrency.sh tests/v4_longpoll_sequence.sh tests/v5_longpoll_reset.sh \
         tests/c1_envelope_format.sh tests/c2_meta_api.sh tests/c3_backward_read.sh; do
  echo "== $t =="; bash "$t" || { echo "FAILED: $t"; break; }
done
```
Expected: all unit tests PASS; every shell test prints its `OK:` line. (`v6_atomic_write_kill.sh` and `v_skill_install.sh` may be environment-sensitive — run if applicable.)

- [ ] **Step 3: Manual smoke (operator, off-CI) — record results in the PR**

Prereq: real `.env` with DingTalk creds + `SESSION_SECRET` + `LIVEHTML_API_TOKEN`; callback registered in the console.
1. `docker compose up -d --build`; upload a page: `curl -X PUT -H "Authorization: Bearer $LIVEHTML_API_TOKEN" --data-binary @examples/demo.html "$BASE/pages/smoke"`.
2. Open `$BASE/pages/smoke` in a LAN browser → redirected to DingTalk QR → scan with a **member** account → lands back on the page; presence chip shows your real name; toggling a checkbox records `by`=your userId (check `GET /pages/smoke/state?meta=1` with the bearer).
3. Repeat with a **non-member** account → 403 "你不是该企业成员".
4. Upload a public page: `curl -X PUT -H "Authorization: Bearer $LIVEHTML_API_TOKEN" -H "X-Public: 1" --data-binary @examples/demo.html "$BASE/pages/open"`; open `$BASE/pages/open` in a fresh/incognito browser → loads and syncs **without** login.
5. Agent state call without bearer → 401; with bearer → 200.

- [ ] **Step 4: Commit + open PR**

```bash
git add README.md
git commit -m "docs: README auth section + deploy/verify checklist"
git push -u origin feat/dingtalk-oauth-login
gh pr create --fill --base main
```

---

## Self-Review (completed by plan author)

**Spec coverage:** §4 architecture → Tasks 5-9; §5 config → Task 1 + 11; §6 routing matrix → Tasks 6/7/8; §7 `/auth/*` → Tasks 4/5; §8 org gate → Task 4; §9 session cookie → Task 2; §10 public mechanism → Tasks 3/9 (+smoke 13); §11 WS + identity → Task 7; §12 sync.js → Task 10; §13 skill/installer → Task 12; §14 error handling → Tasks 2/3/4/5 (fail-closed in 1); §15 deploy → Tasks 11/13; §16 testing → every task's tests + Task 13; §17 module split → file structure; §18 verification items → Task 4 (60121/authCode/expireIn defensiveness) + Task 13 manual smoke (http callback, permissions). No gaps.

**Placeholder scan:** No TBD/TODO. Two narrowly-scoped prose deferrals (README §1 zh tone; `install-skill.cjs` base-url-write location) are bounded edits, not missing logic. Client-JS and public-page-serve verification are explicitly routed to manual smoke (Task 13) because the repo has no JS/MinIO test harness — stated honestly, not hidden.

**Type consistency:** `AuthConfig`, `SessionPayload`, `VerifyResult`, `DingTalkClient`, `humanAllowed`, `apiTokenOk`, `parsePublicMeta`, `roomPublicKey`, `readSession`, `apiGateFail`, `isPublicPage`, `publicCache`, `nowSec` — names used identically across the file-structure interfaces, server wiring, and tests. `SESSION_COOKIE`/`OAUTH_COOKIE` constants shared between `session.ts` and `routes.ts`. Bash `mint_session` mirrors `signToken`'s exact encoding (b64url payload, HMAC over the payload string).
