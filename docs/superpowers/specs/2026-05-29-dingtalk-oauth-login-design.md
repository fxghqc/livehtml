# Optional DingTalk OAuth login for deployed livehtml pages — Design

**Date:** 2026-05-29
**Status:** Approved for planning (brainstorming complete)
**Scope owner:** livehtml server (`server.ts`), client (`public/sync.js`), skill (`skill/SKILL.md`), installer (`scripts/install-skill.cjs` + server-generated `/install`, `/install.ps1`).

## 1. Goal

Add an **optional** DingTalk (钉钉) login gate in front of deployed pages, so that — when configured — a human must authenticate with DingTalk (扫码登录) and be a **member of the configured corp** before they can view or interact with a hosted page. The gate must add **zero complexity to generated HTML**: all auth logic lives in the server and `sync.js`. Generated pages stay "`data-live` attributes + one `<script src=".../sync.js">`".

The authenticated identity becomes a **trustworthy** identity for presence and the `by` field — deliberately activating the previously-deferred "`by` 身份认证" item (its documented trigger, "livehtml 暴露公网或外部团队用 / 需要可信身份", is now met).

## 2. Decisions (locked during brainstorming)

1. **Optionality model = global gate + explicit public exceptions.** Auth is ON iff `DINGTALK_CLIENT_ID` is set. When ON, all `/pages/*` require login except pages explicitly marked public.
2. **Login flow = browser 扫码登录** (OAuth2 authorization-code, modern unified endpoints).
3. **Access policy = 本企业成员** (members of the configured corp only).
4. **Identity reuse = presence + trustworthy `by`** (server-supplied; client labels ignored).
5. **Gating scope = human/agent split + API token.** Human surfaces gated by DingTalk session; agent (read-back HTTP) surfaces gated by a static `LIVEHTML_API_TOKEN` bearer.
6. **Public exception mechanism = upload-time header** (`X-Public: 1` on `PUT /pages/<key>`), persisted as per-page metadata (MinIO object metadata is source of truth).

## 3. Non-goals / out of scope (scope discipline)

- Redis / multi-instance session sharing (sessions are stateless signed cookies, so multi-instance already works for *humans*; the only shared mutable server state remains in-memory rooms, unchanged).
- Refresh-token rotation / long-lived offline DingTalk tokens. We use the user token only during the callback, then discard it; the session is our own cookie.
- Role / department / fine-grained per-user ACLs. Membership in the corp is the only authorization check.
- Per-page allowlists of specific users. (Only: global gate + per-page public flag.)
- Legacy SNS flow (`oapi.dingtalk.com/connect/qrconnect`, `/sns/getuserinfo_bycode`) — explicitly avoided.
- TLS termination / reverse proxy provisioning. If the DingTalk console rejects an `http://` callback, fronting with HTTPS is a deployment/config task, not code (the `redirect_uri` is config-driven).

## 4. Architecture overview

```
Browser ──GET /pages/<key>──► server
  │  no session, page protected → 302 /auth/dingtalk/login?next=/pages/<key>
  ▼
/auth/dingtalk/login ──302──► login.dingtalk.com/oauth2/auth   (QR scan)
                                   │ user scans + confirms
                                   ▼  302 back (browser-side) to LAN host
/auth/dingtalk/callback?authCode=&state=
  ├─ verify state cookie (CSRF)
  ├─ POST userAccessToken (authCode → USER token)        [outbound]
  ├─ GET /contact/users/me (USER token → unionId)        [outbound]
  ├─ ORG GATE: cached APP token → getbyunionid           [outbound]
  │     errcode 0 + userid → member;  60121 → reject 403
  ├─ v2/user/get → in-org display name                   [outbound]
  └─ Set-Cookie: lh_sess=<signed {uid,name,exp}>; 302 → next

Browser ──/ws (cookie sent)──► server
  ├─ at upgrade: verify cookie → attach verified identity (or null) to ws.data
  └─ on "hi" {room}: if no identity AND room not public-page AND auth on → close

Agent ──PUT /pages/<key>, /pages/<key>/state, ...──► server
  └─ require Authorization: Bearer $LIVEHTML_API_TOKEN (when token configured)
```

Same-origin is what makes this clean: the page and its `sync.js` WebSocket both live on the deployment origin, so one cookie covers both. Cross-origin `examples/` embeds (and local `data-live` dev) never send the cookie and keep today's anonymous behavior.

## 5. Configuration (all via env / `.env`, gitignored)

| Var | Meaning | Required when |
|---|---|---|
| `DINGTALK_CLIENT_ID` | App **AppKey** (`client_id`). Presence of this var = DingTalk gate ON. | enabling login |
| `DINGTALK_CLIENT_SECRET` | App **AppSecret**. Used for token exchange + APP token. | enabling login |
| `DINGTALK_CORP_ID` | Configured corp id; optional soft cross-check against the `corpId` returned by the token exchange (`scope=openid corpid`). The hard gate is `getbyunionid`. | optional |
| `LIVEHTML_PUBLIC_BASE_URL` | Stable external origin (e.g. `http://192.168.130.12:39191`) used to build the **exact-match** `redirect_uri`. Falls back to the request origin if unset. | recommended |
| `SESSION_SECRET` | HMAC-SHA256 key for signing the session cookie. Server refuses to enable the DingTalk gate without it (fail-closed). | enabling login |
| `SESSION_TTL_SEC` | Session lifetime. Default `604800` (7 days). | optional |
| `LIVEHTML_API_TOKEN` | Static bearer for agent/HTTP surfaces. Presence = API-token gate ON. **Required when the DingTalk gate is on** (fail-closed coupling — see §14). | protecting agent API; enabling login |

Secrets live only in `.env` (already gitignored) — never in `server.ts`, this spec, or any committed file.

**Backward compatibility:** with none of `DINGTALK_CLIENT_ID` / `LIVEHTML_API_TOKEN` set, the server behaves exactly as today (fully open). The coupling is **one-directional**: the API-token gate may run alone (token without DingTalk), but enabling the DingTalk gate **requires** an API token (fail-closed — see §14), because the login gate only covers human surfaces and would otherwise leave the agent/data surfaces open.

## 6. Auth surfaces (routing matrix)

| Path / method | Class | Gate when enabled |
|---|---|---|
| `GET /pages/<key>` (HTML serve) | human | DingTalk session, unless page `public` |
| `/ws` (upgrade + `hi`) | human | DingTalk session, unless room backed by a `public` page |
| `PUT /pages/<key>`, `DELETE /pages/<key>` | agent | `LIVEHTML_API_TOKEN` |
| `GET /pages/` (list) | agent | `LIVEHTML_API_TOKEN` |
| `GET/PUT/DELETE /pages/<key>/state` (+ `?wait=` long-poll) | agent | `LIVEHTML_API_TOKEN` |
| `GET/PUT/DELETE /state/<room>` | agent | `LIVEHTML_API_TOKEN` |
| `GET /rooms` | agent | `LIVEHTML_API_TOKEN` |
| `GET /`, `/sync.js`, `/install`, `/install.ps1`, `/skill/*`, `/examples/*` | open | none |
| `/auth/*` | open | none (the login machinery itself) |

Notes:
- The existing route ordering already separates `/pages/<key>/state` (state alias) from `/pages/<key>` (HTML). The gate is applied per-class at the top of each branch.
- Agent API token check returns `401` with `WWW-Authenticate: Bearer` on failure.
- A `public` page's state HTTP API is still agent-gated by the token — publicity only relaxes the *human* (DingTalk) gate on the HTML + WS, never the token gate.

## 7. New routes (`/auth/*`)

### `GET /auth/dingtalk/login?next=<relative-path>`
- Sanitize `next` to a same-origin relative path (default `/`); reject absolute/`//` URLs (open-redirect guard).
- Generate random `state`; set short-lived cookie `lh_oauth=<state>` (`HttpOnly; SameSite=Lax; Path=/auth; Max-Age=600`) carrying both `state` and `next` (signed).
- 302 to:
  `https://login.dingtalk.com/oauth2/auth?redirect_uri=<enc>&response_type=code&client_id=<AppKey>&scope=openid%20corpid&state=<state>&prompt=consent`
  where `<enc>` = URL-encoded `${PUBLIC_BASE_URL}/auth/dingtalk/callback`.

### `GET /auth/dingtalk/callback?authCode=&state=`
- Accept `authCode` (modern) or `code` (defensive fallback).
- Verify `state` matches the `lh_oauth` cookie; clear it. Mismatch → 400.
- **Call 2 — token exchange:** `POST https://api.dingtalk.com/v1.0/oauth2/userAccessToken`, JSON `{clientId, clientSecret, code: authCode, grantType:"authorization_code", refreshToken:""}` → `{accessToken, corpId, ...}`.
- (Optional) if `DINGTALK_CORP_ID` set and response `corpId` present and mismatched → reject (soft check).
- **Call 3 — profile:** `GET https://api.dingtalk.com/v1.0/contact/users/me`, header `x-acs-dingtalk-access-token: <USER token>` → `{unionId, nick, ...}`.
- **Org gate** (see §8): `unionId` → `userid` (or reject) → `name`.
- Issue session cookie (see §9); discard the DingTalk USER token. 302 → `next`.
- Failure modes render a small branded HTML page (not a stack trace): "not a corp member" (403), "login failed, retry" (502/400) with a link back to `/auth/dingtalk/login`.

### `GET /auth/logout`
- Clear `lh_sess` (Max-Age=0); 302 → `/` (or `next`).

### `GET /auth/me`
- `{ authenticated: bool, userId?: string, name?: string }` from the verified cookie. Read by `sync.js`. Always 200.

## 8. Org-membership gate

A cached **APP (corp) access token** module, independent of any user:
- `POST https://api.dingtalk.com/v1.0/oauth2/accessToken`, JSON `{appKey, appSecret}` → `{accessToken, expireIn}`.
- Cache in-memory keyed by appKey; refresh ~5 min before `expireIn` (TTL 7200s). Never fetch per request (DingTalk rate-limits token calls).

Gate sequence (in the callback):
1. `POST https://oapi.dingtalk.com/topapi/user/getbyunionid?access_token=<APP>`, JSON `{unionid}`:
   - `errcode === 0 && result.userid` → **member**; capture `userid`.
   - `errcode === 60121` → **not a member → reject (403)**.
   - any other non-zero `errcode` (e.g. `60011`, `33012`) → **error (502)**, do not treat as a clean reject; log it.
2. `POST https://oapi.dingtalk.com/topapi/v2/user/get?access_token=<APP>`, JSON `{userid, language:"zh_CN"}` → `result.name` (and optionally check `result.active === true`). Use `name` as display name; fall back to the profile `nick` if `name` is empty.
3. Session is keyed on the in-org `userid` (stable). `by = userid`; presence/display `name`.

> Verification flag: `60121` as the "not a member" code was corroborated via a third-party errcode mirror, not a clean official fetch. The implementation must treat it as a parameterizable constant and be validated empirically with a known non-member account before trusting it as the sole reject signal. Any non-zero, non-`60121` code is an error, not a reject.

## 9. Session cookie

- Name `lh_sess`. Stateless: `base64url(payloadJSON) + "." + base64url(HMAC_SHA256(payload, SESSION_SECRET))`.
- Payload `{ uid, name, exp }` (`exp` = now + `SESSION_TTL_SEC`).
- Verify: recompute HMAC (constant-time compare), check `exp`. Invalid/expired → treated as no session.
- Flags: `HttpOnly; SameSite=Lax; Path=/; Max-Age=<ttl>`; add `Secure` only when the request/base URL is `https`. (`SameSite=Lax` is required so the cookie is sent on the top-level GET redirect back from DingTalk; `HttpOnly` is fine because `sync.js` reads identity from `/auth/me`, never from the cookie.)
- No server-side session store → survives restarts, multi-instance friendly.

## 10. Public-page mechanism

- On `PUT /pages/<key>` with header `X-Public: 1` (truthy), store the object in MinIO with custom metadata `public=1`. Without the header (or `X-Public: 0`), store/overwrite as private (no `public` metadata).
- Source of truth = MinIO object metadata. To avoid a `statObject` per page view, keep an in-memory `Map<key, boolean>` cache: populated lazily on first `GET` (via `statObject`), and written on every `PUT`/`DELETE` of that key. Cache miss → `statObject` once.
- `GET /pages/<key>`: if DingTalk gate on and page **not** public and no valid session → 302 to login. Public → serve without session.
- WS room ↔ page mapping: room `pages/<key>` is public iff key is public. Used by the `hi`-time gate (§11).

## 11. WebSocket gating + identity propagation

- **At upgrade (`/ws` in `fetch`)**: parse the `Cookie` header, verify `lh_sess`. Put the verified identity (or `null`) into the upgrade `data` (e.g. `data.peer.auth = {uid, name} | null`). Always allow the upgrade itself (room not yet known).
- **On `hi` message** (room is known): let `room = sanitizeRoom(msg.room)`. If DingTalk gate is ON and `peer.auth` is null and the room is **not** backed by a public page → send `{t:"denied", reason:"login_required"}` and `ws.close()`. Otherwise proceed.
- When `peer.auth` is set: override `peer.user = { name: auth.name, userId: auth.uid }` and use `auth.uid` as the trusted `by` for that peer's `set`/`del` (ignore any client-supplied label/clientId for `by`). When `peer.auth` is null (auth off, or public page) → today's anonymous behavior.
- **Edge case — non-page rooms under an active gate:** the `hi` gate keys publicity on `pages/<key>` objects. Rooms that are *not* page-backed — chiefly the `/examples/*` showcase demos (room `examples/...`) and any local-dev `data-live` room pointed at the deployment — have no public flag, so with the gate ON an unauthenticated browser is denied sync on them. This is acceptable: those are open *static* demos, not deployed collaborative pages. Decision: treat any room not matching `pages/<public-key>` as protected when the gate is on (deny-by-default); do **not** add a blanket exception for `examples/`. An authenticated user can still sync them.

## 12. Client (`public/sync.js`) changes

- On `start()`, fetch `/auth/me`. If `authenticated`:
  - Use `{name}` as the user (overriding localStorage/meta); store `userId`.
  - Hide / disable the "点击改名" affordance (identity is server-trusted).
  - Show the real name in the presence chip.
- If not authenticated (or `/auth/me` unreachable / cross-origin): unchanged behavior. `/auth/me` failure must never break sync.
- Handle a `{t:"denied"}` WS message: stop reconnect storm, show a small "需要登录" chip linking to `/auth/dingtalk/login?next=<location.pathname>`.
- These changes are additive and backward compatible; `sync.js` served to a non-auth deployment behaves exactly as today.

## 13. Skill + installer changes (so agents keep working)

- `skill/SKILL.md`: document (a) that when a deployment requires it, agent calls send `Authorization: Bearer <token>` read from `~/.local/state/livehtml/api-token`; (b) the `X-Public: 1` upload header; (c) a one-line note that human viewers may need DingTalk login.
- `/install` + `/install.ps1` + `scripts/install-skill.cjs`: optionally accept/store an API token at `${XDG_STATE_HOME|~/.local/state}/livehtml/api-token` (next to `base-url`). Token is supplied out-of-band (the installer does not invent it).
- Keep these additive: a deployment with no token configured needs no token in agent calls.

## 14. Error handling

- All DingTalk outbound calls: timeout (e.g. 8s), catch network errors → render a friendly retry page (login surface) or `502` (API surface). Never leak secrets or raw upstream bodies to the client; log server-side.
- APP-token fetch failure during a callback → `502` "暂时无法验证身份，请重试".
- Open-redirect guard on `next`. CSRF guard via `state`. Constant-time HMAC compare for the session.
- Fail-closed: if `DINGTALK_CLIENT_ID` is set but `SESSION_SECRET` **or `LIVEHTML_API_TOKEN`** is missing, the server throws at startup and **does not start the gate half-configured** (decision: refuse to serve rather than leave a surface ungated). `LIVEHTML_API_TOKEN` is required here because the DingTalk gate only covers the human surfaces (page HTML + `/ws`); without the token gate, the agent/data surfaces (state API, `/pages/` list, `/rooms`, long-poll) would leave every protected page's live data readable/writable/enumerable by anyone (incl. cross-origin via `*` CORS).

## 15. Deployment action items (operator)

1. In the DingTalk developer console → app → **登录与分享**, register the callback **verbatim**: `http://192.168.130.12:39191/auth/dingtalk/callback` (must exact-match protocol/host/port/path). **Confirm the console accepts an `http://` callback** — this is the #1 feasibility risk; if it forces `https`, front the server with an HTTPS proxy and set `LIVEHTML_PUBLIC_BASE_URL` to that origin.
2. Grant the app the contact-read permission needed for `getbyunionid` / `v2/user/get` (通讯录读权限).
3. Ensure the `livehtml` container has **outbound** internet to `api.dingtalk.com` and `oapi.dingtalk.com`.
4. All page viewers' desktop browsers must be able to route to the callback host (true on the LAN).
5. Populate `.env` with the new vars; set `LIVEHTML_API_TOKEN` and distribute it to agents (stored at `~/.local/state/livehtml/api-token`).

## 16. Testing

- **Unit (Bun test):** session sign/verify (tamper, expiry, constant-time); `next` open-redirect sanitization; `state` CSRF check; cookie flag derivation (http vs https); public-flag cache (PUT sets, DELETE clears, miss→stat); API-token check (present/absent/wrong); the gate decision matrix (auth on/off × public/private × session/no-session × token/no-token).
- **DingTalk HTTP calls:** wrap the 4 outbound calls behind a small injectable client interface; unit-test the callback orchestration with a fake returning member / non-member (`60121`) / error (`60011`) / network-failure. No live DingTalk in CI.
- **Integration (existing test harness in `tests/`):** with gate off → all current tests pass unchanged (regression guard). With gate on → protected page GET 302s to login; public page serves; `/ws` `hi` on protected room without session closes with `denied`; agent endpoints require token.
- **Manual smoke (operator, off-CI):** one real 扫码登录 round trip end-to-end; one non-member rejection; confirm `by` shows the real userId and presence shows the real name.

## 17. Implementation notes / module boundaries

To keep `server.ts` from sprawling, factor auth into small, independently-testable units (exact file layout decided in the plan):
- `auth/session.ts` — sign/verify cookie, cookie header build/parse.
- `auth/dingtalk.ts` — the 4 outbound calls + injectable fetch + APP-token cache.
- `auth/gate.ts` — pure decision functions (`isPageProtected`, `requireHumanSession`, `requireApiToken`) given config + request + public-flag lookup.
- `server.ts` wires routes to these; `/auth/*` handlers live here or in `auth/routes.ts`.

## 18. Open verification items (must confirm before/within implementation)

1. **`http://` callback acceptance** in the DingTalk console (deploy blocker if rejected — fallback is HTTPS proxy, config-only).
2. **`errcode 60121`** as the authoritative non-member signal — validate empirically with a non-member account.
3. **`authCode` vs `code`** callback param — parse both defensively.
4. **`expireIn`** actual value — read from the live token response, don't hard-code.
5. **Contact permission scopes** — confirm the app holds the permissions for `getbyunionid` / `v2/user/get`; otherwise those calls error (handle as 502).
6. **Internal-app token endpoint shape** — `POST /v1.0/oauth2/accessToken {appKey,appSecret}` (single corp internal app), not the multi-tenant `{corpId}/token` variant.
