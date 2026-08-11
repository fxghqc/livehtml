#!/usr/bin/env bash
# A `~` key that is not rewritten within TRANSIENT_TTL_SEC is reclaimed by the
# server: the key leaves room state (so it stops riding every later `init`) and
# the eviction goes out as a `del` marked `by:"" src:"server"`.

set -uo pipefail
source "$(dirname "$0")/_lib.sh"

export TRANSIENT_TTL_SEC=1
start_server
BASE="http://127.0.0.1:$SERVER_PORT"
WS="ws://127.0.0.1:$SERVER_PORT/ws"
KEY="t2-$(date +%s)-$$"
ROOM="pages/$KEY"

ws_ops() { # $1 room  $2 JSON array of ops
  ROOM="$1" OPS="$2" WS="$WS" bun -e '
    const ws = new WebSocket(process.env.WS);
    const ops = JSON.parse(process.env.OPS);
    let fired = false;
    const done = (s) => { if (fired) return; fired = true; console.log(s); try { ws.close(); } catch {} setTimeout(() => process.exit(0), 0); };
    ws.addEventListener("open", () => ws.send(JSON.stringify({ t: "hi", room: process.env.ROOM, clientId: "cli-w" })));
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(String(e.data));
      if (m.t !== "init") return;
      for (const op of ops) ws.send(JSON.stringify(op));
      setTimeout(() => done("SENT"), 300);
    });
    setTimeout(() => done("TIMEOUT"), 5000);
  '
}

# Connect and print the first `del` frame the room broadcasts (or TIMEOUT).
ws_wait_del() { # $1 room  $2 timeout_s
  ROOM="$1" SECS="$2" WS="$WS" bun -e '
    const ws = new WebSocket(process.env.WS);
    let fired = false;
    const done = (s) => { if (fired) return; fired = true; console.log(s); try { ws.close(); } catch {} setTimeout(() => process.exit(0), 0); };
    ws.addEventListener("open", () => ws.send(JSON.stringify({ t: "hi", room: process.env.ROOM, clientId: "cli-l" })));
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(String(e.data));
      if (m.t === "del") done(String(e.data));
    });
    setTimeout(() => done("TIMEOUT"), Number(process.env.SECS) * 1000);
  '
}

# The writer disconnects straight away — reclamation is time-based, not tied to
# the writer's connection, which is the case that leaked before.
OUT=$(ws_ops "$ROOM" '[{"t":"set","key":"~x","v":1},{"t":"set","key":"keep","v":2}]')
[ "$OUT" = "SENT" ] || fail "ws write failed: $OUT"

DEL=$(ws_wait_del "$ROOM" 6)
echo "$DEL" | grep -q '"key":"~x"'    || fail "no eviction del for ~x, got: $DEL"
echo "$DEL" | grep -q '"src":"server"' || fail "eviction del is not marked src=server: $DEL"
echo "$DEL" | grep -q '"by":""'        || fail "eviction del must carry no author: $DEL"
pass "server reclaimed ~x and fanned out del{by:'', src:'server'}"

http GET "$BASE/pages/$KEY/state"
assert_eq 200 "$HTTP_CODE" "state GET failed"
HAS=$(printf '%s' "$BODY" | jq -r 'has("~x")')
KEEP=$(printf '%s' "$BODY" | jq -r '.keep')
[ "$HAS" = "false" ] || fail "~x still in room state after eviction: $BODY"
[ "$KEEP" = "2" ] || fail "the ordinary key was collected too: $BODY"
pass "~x gone from room state, ordinary key untouched"

echo "OK: TRANSIENT_TTL_SEC reclaims stale ~ keys without touching ordinary state"
