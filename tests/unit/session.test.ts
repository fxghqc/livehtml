// tests/unit/session.test.ts
import { test, expect } from "bun:test";
import {
  signToken, verifyToken, signSession, readSession,
  parseCookies, buildSetCookie, SESSION_COOKIE,
} from "../../auth/session.ts";

const SECRET = "test-secret";
const NOW = 1_000_000;

test("signToken/verifyToken roundtrip", () => {
  const t = signToken({ uid: "u1", name: "Alice", exp: NOW + 100 }, SECRET);
  const v = verifyToken<{ uid: string; name: string }>(t, SECRET, NOW);
  expect(v?.uid).toBe("u1");
  expect(v?.name).toBe("Alice");
});

test("rejects tampered payload", () => {
  const t = signToken({ uid: "u1", exp: NOW + 100 }, SECRET);
  const [, sig] = t.split(".");
  const forged = Buffer.from(JSON.stringify({ uid: "admin", exp: NOW + 100 }))
    .toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") + "." + sig;
  expect(verifyToken(forged, SECRET, NOW)).toBeNull();
});

test("rejects wrong secret", () => {
  const t = signToken({ uid: "u1", exp: NOW + 100 }, SECRET);
  expect(verifyToken(t, "other", NOW)).toBeNull();
});

test("rejects expired token", () => {
  const t = signToken({ uid: "u1", exp: NOW - 1 }, SECRET);
  expect(verifyToken(t, SECRET, NOW)).toBeNull();
});

test("readSession reads lh_sess cookie", () => {
  const tok = signSession({ uid: "u9", name: "Bob", exp: NOW + 100 }, SECRET);
  const req = new Request("http://x/", { headers: { cookie: `foo=1; ${SESSION_COOKIE}=${tok}; bar=2` } });
  const s = readSession(req, SECRET, NOW);
  expect(s?.uid).toBe("u9");
  expect(s?.name).toBe("Bob");
});

test("readSession returns null without cookie", () => {
  expect(readSession(new Request("http://x/"), SECRET, NOW)).toBeNull();
});

test("parseCookies handles empty + multiple", () => {
  expect(parseCookies(null)).toEqual({});
  expect(parseCookies("a=1; b=2")).toEqual({ a: "1", b: "2" });
});

test("buildSetCookie sets flags; Secure only when asked", () => {
  const insecure = buildSetCookie("lh_sess", "v", { ttlSec: 60, path: "/", httpOnly: true, sameSite: "Lax" });
  expect(insecure).toContain("lh_sess=v");
  expect(insecure).toContain("HttpOnly");
  expect(insecure).toContain("SameSite=Lax");
  expect(insecure).toContain("Max-Age=60");
  expect(insecure).not.toContain("Secure");
  const secure = buildSetCookie("lh_sess", "v", { ttlSec: 60, path: "/", secure: true });
  expect(secure).toContain("Secure");
});
