// auth/session.ts
import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "lh_sess";
export const OAUTH_COOKIE = "lh_oauth";

export interface SessionPayload {
  uid: string;
  name: string;
  exp: number;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64url(s: string): Buffer {
  let t = s.replace(/-/g, "+").replace(/_/g, "/");
  while (t.length % 4) t += "=";
  return Buffer.from(t, "base64");
}
function hmac(msg: string, secret: string): string {
  return b64url(createHmac("sha256", secret).update(msg).digest());
}

export function signToken(obj: Record<string, unknown>, secret: string): string {
  const payload = b64url(Buffer.from(JSON.stringify(obj), "utf8"));
  return payload + "." + hmac(payload, secret);
}

export function verifyToken<T = any>(token: string, secret: string, nowSec: number): T | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = hmac(payload, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let obj: any;
  try {
    obj = JSON.parse(fromB64url(payload).toString("utf8"));
  } catch {
    return null;
  }
  if (obj && typeof obj === "object" && typeof obj.exp === "number" && obj.exp < nowSec) return null;
  return obj as T;
}

export function signSession(p: SessionPayload, secret: string): string {
  return signToken(p as unknown as Record<string, unknown>, secret);
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

export function readSession(req: Request, secret: string, nowSec: number): SessionPayload | null {
  const cookies = parseCookies(req.headers.get("cookie"));
  const tok = cookies[SESSION_COOKIE];
  if (!tok) return null;
  const v = verifyToken<SessionPayload>(tok, secret, nowSec);
  if (!v || typeof v.uid !== "string") return null;
  return v;
}

export function buildSetCookie(
  name: string,
  value: string,
  opts: { ttlSec: number; path: string; secure?: boolean; httpOnly?: boolean; sameSite?: "Lax" | "Strict" | "None" },
): string {
  const bits = [`${name}=${value}`, `Path=${opts.path}`, `Max-Age=${opts.ttlSec}`];
  bits.push(`SameSite=${opts.sameSite ?? "Lax"}`);
  if (opts.httpOnly) bits.push("HttpOnly");
  if (opts.secure) bits.push("Secure");
  return bits.join("; ");
}

export const API_TOKEN_KIND = "api";

export function signApiToken(uid: string, name: string, ttlSec: number, secret: string, nowSec: number): string {
  return signToken({ uid, name, kind: API_TOKEN_KIND, exp: nowSec + ttlSec }, secret);
}

export function verifyApiToken(token: string, secret: string, nowSec: number): { uid: string; name: string } | null {
  const v = verifyToken<any>(token, secret, nowSec);
  if (!v || v.kind !== API_TOKEN_KIND || typeof v.uid !== "string") return null;
  return { uid: v.uid, name: typeof v.name === "string" ? v.name : v.uid };
}
