// tests/unit/limits.test.ts
import { test, expect } from "bun:test";
import { createOpsLimiter } from "../../limits.ts";

function atClock() {
  let t = 0;
  const limiter = createOpsLimiter({ now: () => t });
  return {
    limiter,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

test("a fresh writer gets a burst of 2x the rate, then is refused", () => {
  const { limiter } = atClock();
  for (let i = 0; i < 20; i++) {
    expect(limiter.take("r", "w", 10).ok).toBe(true);
  }
  const v = limiter.take("r", "w", 10);
  expect(v.ok).toBe(false);
  if (!v.ok) expect(v.retryAfterMs).toBeGreaterThan(0);
});

test("tokens refill at the configured rate", () => {
  const { limiter, advance } = atClock();
  for (let i = 0; i < 20; i++) limiter.take("r", "w", 10);
  expect(limiter.take("r", "w", 10).ok).toBe(false);

  advance(100); // one token at 10/s
  expect(limiter.take("r", "w", 10).ok).toBe(true);
  expect(limiter.take("r", "w", 10).ok).toBe(false);

  advance(10_000); // long idle refills to the cap, not beyond
  let allowed = 0;
  while (limiter.take("r", "w", 10).ok) allowed++;
  expect(allowed).toBe(20);
});

test("budgets are per (room, writer) — one writer cannot starve another", () => {
  const { limiter } = atClock();
  while (limiter.take("r1", "alice", 10).ok) {
    /* drain alice in r1 */
  }
  expect(limiter.take("r1", "alice", 10).ok).toBe(false);
  expect(limiter.take("r1", "bob", 10).ok).toBe(true); // other writer
  expect(limiter.take("r2", "alice", 10).ok).toBe(true); // same writer, other room
});

test("rate 0 disables the limit entirely", () => {
  const { limiter } = atClock();
  for (let i = 0; i < 1000; i++) expect(limiter.take("r", "w", 0).ok).toBe(true);
  expect(limiter.size()).toBe(0); // and buys no bookkeeping
});

test("the retry hint is long enough to actually produce a token", () => {
  const { limiter, advance } = atClock();
  while (limiter.take("r", "w", 10).ok) {
    /* drain */
  }
  const v = limiter.take("r", "w", 10);
  expect(v.ok).toBe(false);
  if (!v.ok) {
    advance(v.retryAfterMs);
    expect(limiter.take("r", "w", 10).ok).toBe(true);
  }
});

test("idle buckets are swept once the map grows past the threshold", () => {
  const { limiter, advance } = atClock();
  for (let i = 0; i < 1100; i++) limiter.take("r", "w" + i, 10);
  const before = limiter.size();
  expect(before).toBeGreaterThan(1024);
  advance(61_000);
  limiter.take("r", "fresh", 10); // any take past the threshold triggers the sweep
  expect(limiter.size()).toBeLessThan(before);
});
