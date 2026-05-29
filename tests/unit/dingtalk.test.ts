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
