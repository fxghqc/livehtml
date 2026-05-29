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
  // Coupling (fail-closed): the DingTalk gate only covers human surfaces (page
  // HTML + /ws). The agent/data surfaces (state API, /pages list, /rooms,
  // long-poll) are token-gated. If the login gate were on while the token gate
  // was off, those surfaces would leave every "protected" page's live data
  // readable/writable/enumerable by anyone (incl. cross-origin via `*` CORS).
  // So when DingTalk is enabled, an API token is REQUIRED.
  if (dingtalkEnabled && !apiToken) {
    throw new Error(
      "DINGTALK_CLIENT_ID is set but LIVEHTML_API_TOKEN is missing — the agent/state surfaces (state API, /pages list, /rooms) would be left open while page HTML is gated. Set LIVEHTML_API_TOKEN so human pages and their data are protected together (fail-closed).",
    );
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
    apiTokenEnabled: apiToken.length > 0,
    apiToken,
  };
}
