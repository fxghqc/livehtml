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

// Non-secret diagnostic log: step + HTTP status + DingTalk code/errcode/message.
// Never logs tokens/secrets/authCode. Surfaces *why* a 502 happened in `docker logs`.
function logd(step: string, detail: Record<string, unknown>): void {
  let d = "";
  try {
    d = JSON.stringify(detail);
  } catch {
    d = "(uninspectable)";
  }
  console.warn(`[auth:dingtalk] ${step} -> ${d}`);
}

export function createDingTalkClient(
  cfg: { clientId: string; clientSecret: string; corpId: string },
  fetchImpl: typeof fetch = fetch,
  clock: () => number = () => Math.floor(Date.now() / 1000),
): DingTalkClient {
  let appToken = "";
  let appTokenExp = 0;

  async function postJson(
    url: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; json: any }> {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  }

  async function getAppToken(): Promise<string> {
    const now = clock();
    if (appToken && now < appTokenExp - APP_TOKEN_SKEW_SEC) return appToken;
    const { status, json } = await postJson("https://api.dingtalk.com/v1.0/oauth2/accessToken", {
      appKey: cfg.clientId,
      appSecret: cfg.clientSecret,
    });
    if (!json.accessToken) {
      logd("appToken", { status, code: json.code, message: json.message });
      throw new Error("app token fetch failed");
    }
    appToken = json.accessToken;
    appTokenExp = now + (Number(json.expireIn) || 7200);
    return appToken;
  }

  async function verifyAuthCode(authCode: string): Promise<VerifyResult> {
    try {
      // Call 2 — exchange authCode -> USER token.
      const ex = await postJson("https://api.dingtalk.com/v1.0/oauth2/userAccessToken", {
        clientId: cfg.clientId,
        clientSecret: cfg.clientSecret,
        code: authCode,
        grantType: "authorization_code",
        refreshToken: "",
      });
      if (!ex.json.accessToken) {
        logd("userAccessToken", { status: ex.status, code: ex.json.code, message: ex.json.message });
        return { ok: false, reason: "error" };
      }
      if (cfg.corpId && ex.json.corpId && ex.json.corpId !== cfg.corpId) {
        logd("corpId-mismatch", { configured: cfg.corpId, got: ex.json.corpId });
        return { ok: false, reason: "not_member" };
      }

      // Call 3 — USER token -> unionId.
      const meRes = await fetchImpl("https://api.dingtalk.com/v1.0/contact/users/me", {
        method: "GET",
        headers: { "x-acs-dingtalk-access-token": ex.json.accessToken, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(8000),
      });
      const me = await meRes.json().catch(() => ({}));
      const unionId: string = me.unionId;
      if (!unionId) {
        logd("contact/users/me", { status: meRes.status, code: me.code, message: me.message });
        return { ok: false, reason: "error" };
      }

      // Org gate — APP token -> getbyunionid.
      const app = await getAppToken();
      const bu = await postJson(
        `https://oapi.dingtalk.com/topapi/user/getbyunionid?access_token=${encodeURIComponent(app)}`,
        { unionid: unionId },
      );
      if (bu.json.errcode === NOT_MEMBER_ERRCODE) {
        logd("getbyunionid", { errcode: bu.json.errcode, errmsg: bu.json.errmsg, result: "not_member" });
        return { ok: false, reason: "not_member" };
      }
      if (bu.json.errcode !== 0 || !bu.json.result?.userid) {
        logd("getbyunionid", { errcode: bu.json.errcode, errmsg: bu.json.errmsg });
        return { ok: false, reason: "error" };
      }
      const userId: string = bu.json.result.userid;

      // Display name — v2/user/get.
      const detail = await postJson(
        `https://oapi.dingtalk.com/topapi/v2/user/get?access_token=${encodeURIComponent(app)}`,
        { userid: userId, language: "zh_CN" },
      );
      if (detail.json.errcode !== 0) logd("v2/user/get", { errcode: detail.json.errcode, errmsg: detail.json.errmsg });
      const name: string = (detail.json.errcode === 0 && detail.json.result?.name) || me.nick || userId;

      return { ok: true, userId, name };
    } catch (e: any) {
      logd("exception", { message: (e && e.message) || String(e) });
      return { ok: false, reason: "error" };
    }
  }

  return { verifyAuthCode };
}
