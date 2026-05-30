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
