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
  apiTokenTtlSec: number;
  roomTokenTtlSec: number;
}

export function loadAuthConfig(env: Record<string, string | undefined>): AuthConfig {
  const clientId = (env.DINGTALK_CLIENT_ID || "").trim();
  const clientSecret = (env.DINGTALK_CLIENT_SECRET || "").trim();
  const sessionSecret = (env.SESSION_SECRET || "").trim();
  const apiToken = (env.LIVEHTML_API_TOKEN || "").trim();
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
  return {
    dingtalkEnabled,
    clientId,
    clientSecret,
    corpId: (env.DINGTALK_CORP_ID || "").trim(),
    baseUrl: (env.LIVEHTML_PUBLIC_BASE_URL || "").trim().replace(/\/+$/, ""),
    sessionSecret,
    sessionTtlSec: Number.isFinite(ttl) && ttl > 0 ? Math.floor(ttl) : 604800,
    apiTokenTtlSec: (() => {
      const t = Number(env.API_TOKEN_TTL_SEC);
      return Number.isFinite(t) && t > 0 ? Math.floor(t) : 2592000;
    })(),
    // Minted per page GET and held by an open page for as long as it stays
    // open, with no refresh path — so it outlives a session on purpose. An
    // expired one shows up as a `denied` frame and is fixed by reloading the
    // page. Revoking early means rotating SESSION_SECRET (which also drops
    // sessions and api tokens).
    roomTokenTtlSec: (() => {
      const t = Number(env.ROOM_TOKEN_TTL_SEC);
      return Number.isFinite(t) && t > 0 ? Math.floor(t) : 604800;
    })(),
    apiTokenEnabled: apiToken.length > 0,
    apiToken,
  };
}
