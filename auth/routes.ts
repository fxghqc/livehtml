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
