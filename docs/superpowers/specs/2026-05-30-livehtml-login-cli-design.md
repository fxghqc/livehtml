# `livehtml login` — dws-style CLI login + per-user API tokens — Design

**Date:** 2026-05-30
**Status:** Draft for review (extends the DingTalk-login feature)
**Builds on:** `docs/superpowers/specs/2026-05-29-dingtalk-oauth-login-design.md` (the human login gate + static-token agent gate already shipped on `feat/dingtalk-oauth-login`).

## 1. Problem

Today an agent gets its API token by the operator generating a shared `LIVEHTML_API_TOKEN` and hand-copying it to every machine (`~/.local/state/livehtml/api-token`). That's unfriendly. The local `dws` CLI sets the bar: `dws auth login` drives a DingTalk OAuth login, caches an access/refresh token locally, and auto-refreshes — the human only ever sees a QR ~monthly.

**Goal:** give livehtml the same UX — a `livehtml login` that opens the browser, the human 扫码s **once**, and a **per-user** livehtml API token lands in the local state dir automatically (zero copy-paste), reusing the DingTalk login already built.

## 2. Decisions (from brainstorming)

1. **Mechanism = Option 3 (CLI loopback handoff)**, like dws — not a copy-paste page.
2. **Token = per-user signed bearer** (Option 1), minted by the livehtml server, not a DingTalk token (different audience — a DingTalk token for dws's app can't authenticate to livehtml).
3. **Static `LIVEHTML_API_TOKEN` becomes optional** (CI/headless break-glass). When DingTalk is on, per-user tokens satisfy the agent gate, so the previously-required static token is no longer mandatory — **this supersedes the 2026-05-29 spec §5/§14 fail-closed coupling** (see §7).

## 3. Token model

- An **API token** is `signToken({ uid, name, kind: "api", exp }, SESSION_SECRET)` — the same HMAC machinery as the session cookie (`auth/session.ts`), so no new crypto and no server-side store.
- **TTL:** default 30 days (`API_TOKEN_TTL_SEC`, configurable). On expiry the agent/human re-runs `livehtml login` (QR ~monthly, matching dws's refresh-expiry cadence).
- **Silent refresh (no QR):** `POST /auth/token/refresh` accepts a *still-valid* api token as `Authorization: Bearer` and returns a fresh one. So `livehtml login` can renew without a browser when it already holds a valid token; only a fully-expired token forces a new 扫码.
- **Acceptance:** `apiTokenOk` accepts **either** a constant-time match against the static `LIVEHTML_API_TOKEN` (if configured) **or** a valid signed api token (`kind === "api"`, not expired, HMAC verified with `SESSION_SECRET`).
- **Attribution (bonus):** when a request authenticates via a signed api token, the agent state writes stamp `by = uid` (the real person) instead of the generic `"http"`. The static token keeps `by = "http"`.
- **Revocation:** rotating `SESSION_SECRET` invalidates all api tokens (and all sessions) at once. Per-user revocation is out of scope (would need a version/denylist — deferred).

## 4. Server endpoints

### `GET /auth/token` — mint, behind the DingTalk gate
- If `!dingtalkEnabled` → 404 (no per-user tokens without login).
- If no valid session → falls through to the human gate → 302 to `/auth/dingtalk/login?next=/auth/token?...` (so login happens, then we return here).
- With a valid session:
  - **`?cli=<loopback-url>`** present → this is the CLI loopback flow. **Strictly validate** `cli` (see §5). If valid: mint an api token and **302 redirect the browser to** `<loopback-url>?token=<api-token>&name=<urlenc name>&exp=<unix>`. If invalid → 400, mint nothing.
  - No `cli` → render an HTML page showing the token + copy button + a one-line install snippet (manual fallback / inspection).
- `?format=json` → `{ token, name, exp }` for scripting (still session-gated).

### `POST /auth/token/refresh` — silent renew
- Auth: `Authorization: Bearer <current api token>`. Verify it's a valid, unexpired signed api token. (Does **not** require a session cookie — this is the headless renew path.)
- On success → `{ token, name, exp }` with a fresh token. On invalid/expired → 401 (caller must re-login).

### Changes to existing
- `auth/gate.ts apiTokenOk(req, staticToken, sessionSecret, nowSec)` — extended to accept signed api tokens; returns `{ ok, uid? }` (uid present when authenticated via a signed token, for attribution).
- `apiGateFail` (server.ts) — gate is **active when `dingtalkEnabled || apiTokenEnabled`** (previously only when a static token was set). When active and the credential is missing/invalid → 401 `WWW-Authenticate: Bearer`.

## 5. Loopback security (the critical control)

The token is handed to the CLI by redirecting the browser to a localhost URL. If that target weren't strictly validated, any web page could drive the browser to `/auth/token?cli=https://evil.com/x` and exfiltrate a token. Controls:

1. **Loopback allowlist (hard gate):** `cli` MUST match `^http://(127\.0\.0\.1|localhost|\[::1\]):\d{1,5}(/[A-Za-z0-9._~/-]*)?$`. Reject anything else (no `https`, no external host, no userinfo, no `@`). Implemented as a pure, unit-tested function `isLoopbackRedirect(url)`.
2. **Session required:** a token is only minted for an authenticated corp member with a valid `lh_sess` cookie — a random site cannot mint without the user having logged into livehtml in that browser.
3. **One-time CLI nonce (CSRF/binding):** `livehtml login` generates a `cliNonce`, passes it through `state`→`next`, and the loopback `/cb` only accepts the redirect carrying the matching nonce. Prevents a stray/forged redirect from injecting a token into a waiting CLI.
4. **Token in query to loopback only:** acceptable per RFC 8252 (native-app loopback); the request never leaves the local machine. `Cache-Control: no-store` on the mint response.
5. **Ephemeral listener:** the CLI binds `127.0.0.1:0` (random port), serves exactly one `/cb`, then shuts down. Short timeout (e.g. 120 s) then aborts.

## 6. CLI: `livehtml login`

- **Runtime:** Bun + TypeScript, zero-dependency (`scripts/livehtml-login.ts`, run with `bun`), consistent with the Bun/TS server and tests. Uses `node:http`/`node:crypto`/`node:child_process`/`node:fs` (Bun-compatible) + the global `fetch` for refresh.
- **Resolve base URL:** from `~/.local/state/livehtml/base-url` (or `--base`/`LIVEHTML_BASE_URL`).
- **Flow:**
  1. If a valid cached token exists and is >N days from expiry → print "already logged in as <name>" and exit. If valid but near expiry → try `POST /auth/token/refresh` (no browser); on success, save + exit.
  2. Else: bind `127.0.0.1:0`; build `cliNonce`; open the browser (`open`/`xdg-open`/`start`, with a printed fallback URL) to `"$BASE/auth/dingtalk/login?next=" + enc("/auth/token?cli=" + enc("http://127.0.0.1:PORT/cb") + "&n=" + cliNonce)`.
  3. The one-shot `/cb` handler validates the `n` nonce, reads `token`/`name`/`exp`, writes `~/.local/state/livehtml/api-token` (mode 600), prints `✓ logged in as <name> (expires <date>)`, returns a "✓ 你可以关闭这个标签页" HTML page, and exits 0. Timeout → exit non-zero with guidance.
- **Distribution:** the server serves the script at `GET /login.ts` and the `/install` script additionally fetches it to `$STATE_DIR/livehtml-login.ts` and prints `bun …` as the run command. `package.json` gains a `livehtml-login` bin (Bun shebang).
- **Agent usage afterward (unchanged surface):** read `~/.local/state/livehtml/api-token`, send `Authorization: Bearer <token>`. SKILL.md updated to say "run `livehtml login` once" instead of hand-copying.

## 7. Supersedes / migration

- The 2026-05-29 spec §5/§14 required `LIVEHTML_API_TOKEN` whenever `DINGTALK_CLIENT_ID` was set (fail-closed). **That coupling is replaced:** with per-user tokens, the agent gate is satisfied by signed tokens. New rule:
  - `dingtalkEnabled` requires `SESSION_SECRET` (unchanged) but **no longer requires** `LIVEHTML_API_TOKEN`.
  - The agent gate is active when `dingtalkEnabled || apiTokenEnabled`; with neither, surfaces stay open (backward compatible).
- The config unit test "dingtalk enabled requires api token (fail closed)" is **removed/replaced** by "dingtalk enabled does NOT require api token (per-user tokens suffice)". README/.env updated accordingly.

## 8. Out of scope

Per-user token revocation lists; refresh-token rotation beyond re-mint; OS keychain storage (stay with the `~/.local/state` file, mode 600, matching `dws`'s file-based cache and the existing `base-url`/`api-token` convention); a full `livehtml` multi-command CLI (only `login`, plus `logout`/`status` as thin helpers if cheap).

## 9. Testing

- **Unit (`bun test`):** `isLoopbackRedirect` (accept 127.0.0.1/localhost/[::1] + port + path; reject https, external host, `@`, missing port, scheme tricks); api-token mint/verify roundtrip + `kind`/exp checks; `apiTokenOk` accepts static OR signed, rejects expired/forged/wrong-kind; gate-active matrix (`dingtalkEnabled || apiTokenEnabled`).
- **Integration (`.sh`):** with DingTalk on + a forged session cookie, `GET /auth/token?cli=http://127.0.0.1:9/cb&n=X` → 302 to that loopback with `token=`; `?cli=https://evil.com` → 400, no token; `GET /auth/token?format=json` → `{token,...}`; `POST /auth/token/refresh` with a minted token → fresh token, with a forged/expired one → 401; an `apiGateFail` surface accepts a signed token (no static token configured).
- **CLI:** a scripted end-to-end using a forged session is hard (needs a browser); cover `isLoopbackRedirect` + the mint/refresh endpoints by unit/integration, and the CLI's token-file write by a focused Node test with a stub `/cb` round-trip against a started server. Full 扫码 round-trip = manual smoke.
- Regression: the entire existing suite stays green; the superseded fail-closed test is updated, not deleted-and-forgotten.

## 10. Open items to confirm in the DingTalk console

- Register the **loopback callback** `http://127.0.0.1:<port>/...`? No — the CLI does **not** register its own DingTalk callback. The browser still hits the **server's** already-registered `…/auth/dingtalk/callback`; only the *final* hop (`/auth/token` → `http://127.0.0.1:PORT/cb`) is a livehtml-internal redirect, invisible to DingTalk. So **no new DingTalk console change is needed** beyond the existing server callback. (This is why minting happens server-side after the normal login, then redirects to loopback — keeping DingTalk's registered redirect_uri stable.)
