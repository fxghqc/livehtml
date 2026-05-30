// tests/unit/gate.test.ts
import { test, expect } from "bun:test";
import { sanitizeNext, apiTokenOk, humanAllowed, parsePublicMeta, isLoopbackRedirect } from "../../auth/gate.ts";
import { roomPublicKey } from "../../auth/gate.ts";
import { signApiToken } from "../../auth/session.ts";

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

test("apiTokenOk: static bearer match", () => {
  const ok = new Request("http://x/", { headers: { authorization: "Bearer s3cret" } });
  const bad = new Request("http://x/", { headers: { authorization: "Bearer nope" } });
  const none = new Request("http://x/");
  expect(apiTokenOk(ok, "s3cret", "", 1000).ok).toBe(true);
  expect(apiTokenOk(bad, "s3cret", "", 1000).ok).toBe(false);
  expect(apiTokenOk(none, "s3cret", "", 1000).ok).toBe(false);
});

test("apiTokenOk: signed per-user token accepted, exposes uid", () => {
  const tok = signApiToken("u5", "Eve", 100, "sek", 1000);
  const req = new Request("http://x/", { headers: { authorization: "Bearer " + tok } });
  const r = apiTokenOk(req, "", "sek", 1000);
  expect(r.ok).toBe(true);
  expect(r.uid).toBe("u5");
});

test("apiTokenOk: expired signed token rejected", () => {
  const tok = signApiToken("u5", "Eve", -1, "sek", 1000);
  const req = new Request("http://x/", { headers: { authorization: "Bearer " + tok } });
  expect(apiTokenOk(req, "", "sek", 1000).ok).toBe(false);
});

test("isLoopbackRedirect accepts localhost/127/::1 with a port", () => {
  expect(isLoopbackRedirect("http://127.0.0.1:5000/cb")).toBe(true);
  expect(isLoopbackRedirect("http://localhost:49213/cb")).toBe(true);
  expect(isLoopbackRedirect("http://[::1]:8080/cb")).toBe(true);
});

test("isLoopbackRedirect rejects external/https/no-port/userinfo", () => {
  expect(isLoopbackRedirect("https://127.0.0.1:5000/cb")).toBe(false); // https
  expect(isLoopbackRedirect("http://evil.com:5000/cb")).toBe(false);   // external host
  expect(isLoopbackRedirect("http://127.0.0.1/cb")).toBe(false);       // no port
  expect(isLoopbackRedirect("http://user@127.0.0.1:5000/cb")).toBe(false); // userinfo
  expect(isLoopbackRedirect("http://127.0.0.1.evil.com:80/cb")).toBe(false);
  expect(isLoopbackRedirect(null)).toBe(false);
});

test("parsePublicMeta reads public flag", () => {
  expect(parsePublicMeta({ public: "1" })).toBe(true);
  expect(parsePublicMeta({ "x-amz-meta-public": "1" })).toBe(true);
  expect(parsePublicMeta({ public: "0" })).toBe(false);
  expect(parsePublicMeta(undefined)).toBe(false);
  expect(parsePublicMeta({})).toBe(false);
});

test("roomPublicKey extracts page key from pages/ rooms only", () => {
  expect(roomPublicKey("pages/abc")).toBe("abc");
  expect(roomPublicKey("pages/team/q3")).toBe("team/q3");
  expect(roomPublicKey("default")).toBeNull();
  expect(roomPublicKey("examples/demo.html")).toBeNull();
});
