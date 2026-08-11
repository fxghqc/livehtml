// Per-(room, writer) token bucket for the upstream `set`/`del` ops.
// Dependency-free and clock-injected so the policy is testable without a server
// or a real clock.
//
// The rate is passed in on every take rather than captured at construction, so
// a config change takes effect on the next message and buckets already in
// flight re-converge on the new capacity.

export type OpsLimitVerdict = { ok: true } | { ok: false; retryAfterMs: number };

export type OpsLimiter = {
  take: (room: string, writer: string, ratePerSec: number) => OpsLimitVerdict;
  size: () => number;
};

type Bucket = { tokens: number; last: number };

const SWEEP_ABOVE = 1024;
const IDLE_MS = 60_000;
// NUL separates the two halves of the key: neither a room (sanitizeRoom) nor a
// writer id contains a control character, so no pair can collide with another.
const KEY_SEP = String.fromCharCode(0);

export function createOpsLimiter(opts?: { now?: () => number }): OpsLimiter {
  const now = opts?.now ?? Date.now;
  const buckets = new Map<string, Bucket>();

  return {
    take(room, writer, ratePerSec) {
      if (!(ratePerSec > 0)) return { ok: true };

      const t = now();
      // Bounded by live writers in practice; the sweep is the backstop for a
      // long-running server that has seen many short-lived connections.
      if (buckets.size > SWEEP_ABOVE) {
        for (const [k, b] of buckets) {
          if (t - b.last > IDLE_MS) buckets.delete(k);
        }
      }

      // A burst of one second's worth on top of the steady rate: a page that
      // opens by writing a screenful of keys should not trip on its own first
      // paint, while a runaway loop still settles to ratePerSec.
      const cap = 2 * ratePerSec;
      const key = room + KEY_SEP + writer;
      const prev = buckets.get(key);
      const tokens = prev
        ? Math.min(cap, prev.tokens + ((t - prev.last) / 1000) * ratePerSec)
        : cap;

      if (tokens < 1) {
        buckets.set(key, { tokens, last: t });
        return { ok: false, retryAfterMs: Math.max(50, Math.ceil(((1 - tokens) / ratePerSec) * 1000)) };
      }
      buckets.set(key, { tokens: tokens - 1, last: t });
      return { ok: true };
    },

    size: () => buckets.size,
  };
}
