// auth/gate.ts
import { timingSafeEqual } from "node:crypto";
import { verifyApiToken } from "./session.ts";

// A safe same-origin destination: must start with a single "/" and not "//".
export function sanitizeNext(raw: string | null): string {
  if (!raw) return "/";
  if (!raw.startsWith("/")) return "/";
  if (raw.startsWith("//")) return "/";
  if (raw.includes("\\")) return "/";
  return raw;
}

export interface ApiAuth {
  ok: boolean;
  uid?: string;
}

// Accept EITHER a constant-time match against the static token OR a valid
// signed per-user api token. uid is set only for the signed path (attribution).
export function apiTokenOk(req: Request, staticToken: string, sessionSecret: string, nowSec: number): ApiAuth {
  const h = req.headers.get("authorization") || "";
  if (!h.startsWith("Bearer ")) return { ok: false };
  const presented = h.slice("Bearer ".length);
  if (staticToken) {
    const a = Buffer.from(presented);
    const b = Buffer.from(staticToken);
    if (a.length === b.length && timingSafeEqual(a, b)) return { ok: true };
  }
  if (sessionSecret) {
    const v = verifyApiToken(presented, sessionSecret, nowSec);
    if (v) return { ok: true, uid: v.uid };
  }
  return { ok: false };
}

// True only for an http loopback URL with an explicit port and no userinfo.
// This is the hard gate that prevents token exfiltration to arbitrary hosts.
export function isLoopbackRedirect(raw: string | null): boolean {
  if (!raw) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "http:") return false;
  if (u.username || u.password) return false;
  if (u.search || u.hash) return false; // the server appends ?token=…; the CLI's cb carries neither
  if (!u.port) return false;
  const host = u.hostname; // URL normalizes IPv6 to bracketed form, e.g. "[::1]"
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
}

// True when the request is a browser NAVIGATION (address bar, link, redirect,
// frame load) rather than script-initiated (fetch/XHR). This is the line that
// separates "a person went here" from "code running in a published page went
// here" — and it holds because Sec-Fetch-* are forbidden headers: page JS
// cannot set or clear them. When a proxy strips them entirely we fall back to
// the Accept header, which fetch()'s default `*/*` does not satisfy.
export function isNavigation(req: Request, allowFrame = false): boolean {
  const mode = req.headers.get("sec-fetch-mode");
  const dest = req.headers.get("sec-fetch-dest");
  if (mode || dest) {
    if (mode !== "navigate") return false;
    return dest === "document" || (allowFrame && (dest === "iframe" || dest === "frame"));
  }
  return (req.headers.get("accept") || "").includes("text/html");
}

export function humanAllowed(a: { gateOn: boolean; isPublic: boolean; hasSession: boolean }): boolean {
  if (!a.gateOn) return true;
  return a.isPublic || a.hasSession;
}

export function parsePublicMeta(metaData: Record<string, string> | undefined): boolean {
  if (!metaData) return false;
  return metaData.public === "1" || metaData["x-amz-meta-public"] === "1";
}

// Rooms a page may READ besides its own, declared at publish time. Stored as
// one comma-separated object-metadata value; MinIO reports metadata keys with
// or without the `x-amz-meta-` prefix depending on the call, hence both
// spellings (same as parsePublicMeta).
export function parseReadRooms(metaData: Record<string, string> | undefined): string[] {
  if (!metaData) return [];
  const raw = metaData["read-rooms"] ?? metaData["x-amz-meta-read-rooms"] ?? "";
  return String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Maps a room id to the page key whose public-flag governs it, or null if the
// room is not page-backed (those are deny-by-default when the gate is on).
export function roomPublicKey(room: string): string | null {
  if (room === "pages" || room === "pages/") return null;
  if (room.startsWith("pages/")) return room.slice("pages/".length);
  return null;
}
