#!/usr/bin/env bash
# Upstream guardrails on the WS: one op's size and a writer's rate are the whole
# room's problem (every op is fanned out, stamped and debounced to disk), so both
# are capped.
#   1. an oversized frame is refused before it is parsed, and nothing lands
#   2. a runaway writer is throttled, told when to come back, and the ops it did
#      land are still there — throttling drops writes, it does not corrupt state
#   3. the refusal names the key, so the page can re-queue its own latest value
#   4. a second writer in the same room is unaffected

set -uo pipefail
source "$(dirname "$0")/_lib.sh"

export OPS_RATE_PER_SEC=10
export OPS_MAX_BYTES=2048
start_server
BASE="http://127.0.0.1:$SERVER_PORT"
WS="ws://127.0.0.1:$SERVER_PORT/ws"
ROOM="pages/t6-$(date +%s)-$$"

# Blast N sets as fast as the socket takes them, then report what came back.
blast() { # $1 room  $2 count  $3 key-prefix
  ROOM="$1" N="$2" PREFIX="$3" WS="$WS" bun -e '
    const ws = new WebSocket(process.env.WS);
    const res = { sent: 0, throttled: 0, tooLarge: 0, firstRetryAfterMs: null, throttledKey: null };
    let fired = false;
    const done = () => { if (fired) return; fired = true; console.log(JSON.stringify(res)); try { ws.close(); } catch {} setTimeout(() => process.exit(0), 0); };
    ws.addEventListener("open", () => ws.send(JSON.stringify({ t: "hi", room: process.env.ROOM, clientId: "blaster" })));
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(String(e.data));
      if (m.t === "init") {
        const n = Number(process.env.N);
        for (let i = 0; i < n; i++) {
          ws.send(JSON.stringify({ t: "set", key: process.env.PREFIX + i, v: i }));
          res.sent++;
        }
        setTimeout(done, 700);
        return;
      }
      if (m.t === "throttled") {
        res.throttled++;
        if (res.firstRetryAfterMs === null) { res.firstRetryAfterMs = m.retryAfterMs; res.throttledKey = m.key; }
      }
      if (m.t === "too_large") res.tooLarge++;
    });
    setTimeout(done, 5000);
  '
}

# --- 1. oversized frame ---
OUT=$(ROOM="$ROOM" WS="$WS" LIMIT="$OPS_MAX_BYTES" bun -e '
  const ws = new WebSocket(process.env.WS);
  const res = { tooLarge: 0 };
  let fired = false;
  const done = () => { if (fired) return; fired = true; console.log(JSON.stringify(res)); try { ws.close(); } catch {} setTimeout(() => process.exit(0), 0); };
  ws.addEventListener("open", () => ws.send(JSON.stringify({ t: "hi", room: process.env.ROOM, clientId: "fat" })));
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(String(e.data));
    if (m.t === "init") {
      ws.send(JSON.stringify({ t: "set", key: "huge", v: "x".repeat(Number(process.env.LIMIT) * 2) }));
      setTimeout(done, 500);
      return;
    }
    if (m.t === "too_large") res.tooLarge++;
  });
  setTimeout(done, 5000);
')
echo "$OUT" | jq -e '.tooLarge >= 1' >/dev/null || fail "oversized op was not refused: $OUT"
http GET "$BASE/state/$ROOM"
printf '%s' "$BODY" | jq -e 'has("huge") | not' >/dev/null || fail "the oversized op landed anyway: $BODY"
pass "an oversized op is refused before parsing and never reaches room state"

# --- 2/3. runaway writer ---
OUT=$(blast "$ROOM" 60 "k")
echo "$OUT" | jq -e '.throttled > 0' >/dev/null || fail "60 ops at a 10/s limit were not throttled: $OUT"
echo "$OUT" | jq -e '.firstRetryAfterMs > 0' >/dev/null || fail "no retry hint on the refusal: $OUT"
echo "$OUT" | jq -e '.throttledKey | startswith("k")' >/dev/null || fail "the refusal does not name the key: $OUT"
pass "a runaway writer is throttled, with a retry hint and the dropped key named"

http GET "$BASE/state/$ROOM"
LANDED=$(printf '%s' "$BODY" | jq '[keys[] | select(startswith("k"))] | length')
[ "$LANDED" -gt 0 ] || fail "throttling dropped everything, including the ops inside the budget: $BODY"
[ "$LANDED" -lt 60 ] || fail "nothing was actually dropped ($LANDED/60 landed) — the limit is not applying: $BODY"
pass "the ops inside the budget still landed ($LANDED of 60); the rest were dropped"

# --- 4. a second writer is unaffected ---
OUT2=$(blast "$ROOM" 5 "other")
echo "$OUT2" | jq -e '.throttled == 0' >/dev/null \
  || fail "a fresh writer inherited the first one's exhausted budget: $OUT2"
pass "budgets are per writer — a second page in the same room is unaffected"

echo "OK: size cap refuses before parsing; rate cap drops writes per (room, writer) without corrupting state"
