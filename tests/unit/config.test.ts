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

test("dingtalk enabled does NOT require api token (per-user tokens suffice)", () => {
  const c = loadAuthConfig({ DINGTALK_CLIENT_ID: "k", DINGTALK_CLIENT_SECRET: "s", SESSION_SECRET: "secret" });
  expect(c.dingtalkEnabled).toBe(true);
  expect(c.apiTokenEnabled).toBe(false);
});

test("apiTokenTtlSec defaults to 30 days and parses override", () => {
  expect(loadAuthConfig({}).apiTokenTtlSec).toBe(2592000);
  expect(loadAuthConfig({ API_TOKEN_TTL_SEC: "3600" }).apiTokenTtlSec).toBe(3600);
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

test("api token gate can run alone (without dingtalk)", () => {
  // Token-only is allowed; the coupling is one-directional (dingtalk requires a
  // token, but a token does not require dingtalk).
  const c = loadAuthConfig({ LIVEHTML_API_TOKEN: "tok" });
  expect(c.dingtalkEnabled).toBe(false);
  expect(c.apiTokenEnabled).toBe(true);
});
