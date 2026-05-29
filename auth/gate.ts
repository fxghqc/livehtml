// auth/gate.ts
import { timingSafeEqual } from "node:crypto";

// A safe same-origin destination: must start with a single "/" and not "//".
export function sanitizeNext(raw: string | null): string {
  if (!raw) return "/";
  if (!raw.startsWith("/")) return "/";
  if (raw.startsWith("//")) return "/";
  if (raw.includes("\\")) return "/";
  return raw;
}

export function apiTokenOk(req: Request, token: string): boolean {
  if (!token) return false;
  const h = req.headers.get("authorization") || "";
  const prefix = "Bearer ";
  if (!h.startsWith(prefix)) return false;
  const got = Buffer.from(h.slice(prefix.length));
  const want = Buffer.from(token);
  return got.length === want.length && timingSafeEqual(got, want);
}

export function humanAllowed(a: { gateOn: boolean; isPublic: boolean; hasSession: boolean }): boolean {
  if (!a.gateOn) return true;
  return a.isPublic || a.hasSession;
}

export function parsePublicMeta(metaData: Record<string, string> | undefined): boolean {
  if (!metaData) return false;
  return metaData.public === "1" || metaData["x-amz-meta-public"] === "1";
}
