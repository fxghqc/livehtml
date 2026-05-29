// tests/unit/gate.test.ts
import { test, expect } from "bun:test";
import { sanitizeNext, apiTokenOk, humanAllowed, parsePublicMeta } from "../../auth/gate.ts";
import { roomPublicKey } from "../../auth/gate.ts";

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

test("apiTokenOk matches bearer, rejects others", () => {
  const ok = new Request("http://x/", { headers: { authorization: "Bearer s3cret" } });
  const bad = new Request("http://x/", { headers: { authorization: "Bearer nope" } });
  const none = new Request("http://x/");
  expect(apiTokenOk(ok, "s3cret")).toBe(true);
  expect(apiTokenOk(bad, "s3cret")).toBe(false);
  expect(apiTokenOk(none, "s3cret")).toBe(false);
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
