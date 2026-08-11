#!/usr/bin/env bash
# `~` (live-only) keys: they live in room memory and broadcast like any other
# key, but they never reach the persisted envelope and never move the version
# counter — so a parked `?wait=` long-poll does not wake on one.

set -uo pipefail
source "$(dirname "$0")/_lib.sh"

start_server
BASE="http://127.0.0.1:$SERVER_PORT"
WS="ws://127.0.0.1:$SERVER_PORT/ws"
KEY="t1-$(date +%s)-$$"
ROOM="pages/$KEY"

# Connect, wait for init, send the given ops, exit.
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

OUT=$(ws_ops "$ROOM" '[{"t":"set","key":"~cursor","v":{"x":1}},{"t":"set","key":"n1","v":"keep"}]')
[ "$OUT" = "SENT" ] || fail "ws write failed: $OUT"

# 1. Both keys are readable — a `~` key is ordinary state in memory.
http GET "$BASE/pages/$KEY/state"
assert_eq 200 "$HTTP_CODE" "state GET failed"
CUR=$(printf '%s' "$BODY" | jq -r '."~cursor".x')
N1=$(printf '%s' "$BODY" | jq -r '.n1')
[ "$CUR" = "1" ] && [ "$N1" = "keep" ] || fail "expected both keys in memory, got: $BODY"
pass "a ~ key is readable in room state like any other"

# 2. …but it never reaches disk. scheduleSave debounces 300ms.
sleep 0.6
FILE="$SERVER_RUNDIR/state/pages__$KEY.json"
[ -f "$FILE" ] || fail "state file $FILE missing"
HAS_TRANSIENT=$(jq -r '.fields | has("~cursor")' "$FILE")
HAS_NORMAL=$(jq -r '.fields | has("n1")' "$FILE")
[ "$HAS_TRANSIENT" = "false" ] || fail "~cursor was persisted: $(cat "$FILE")"
[ "$HAS_NORMAL" = "true" ] || fail "n1 was NOT persisted: $(cat "$FILE")"
pass "~ key excluded from the on-disk envelope, ordinary key kept"

# 3. Long-poll bootstrap: a `since`-less poll returns the reset envelope, which
#    carries this process's bootId; one more poll gets the current version.
http GET "$BASE/pages/$KEY/state?wait=1"
ETAG=$(printf '%s' "$BODY" | jq -r .etag)
BOOT=${ETAG%%:*}
[ -n "$BOOT" ] || fail "no bootId in reset etag: $BODY"
http GET "$BASE/pages/$KEY/state?wait=1&since=$BOOT:0"
VER=$(printf '%s' "$BODY" | jq -r .version)
[ "$VER" != "null" ] || fail "no version in long-poll response: $BODY"

# 4. A `~` write must NOT wake a parked long-poll.
POLL_OUT=$(mktemp -t livehtml-poll-XXXXXX)
curl -sS "$BASE/pages/$KEY/state?wait=2&since=$BOOT:$VER" >"$POLL_OUT" &
POLL_PID=$!
sleep 0.3
ws_ops "$ROOM" '[{"t":"set","key":"~cursor","v":{"x":2}}]' >/dev/null
wait "$POLL_PID"
STATUS=$(jq -r .status "$POLL_OUT")
[ "$STATUS" = "not_modified" ] || fail "a ~ write woke the long-poll: $(cat "$POLL_OUT")"
pass "parked long-poll stays asleep across a ~ write"

# 5. Positive control: an ordinary write on the same room does wake it.
curl -sS "$BASE/pages/$KEY/state?wait=5&since=$BOOT:$VER" >"$POLL_OUT" &
POLL_PID=$!
sleep 0.3
ws_ops "$ROOM" '[{"t":"set","key":"n2","v":"wake"}]' >/dev/null
wait "$POLL_PID"
STATUS=$(jq -r .status "$POLL_OUT")
[ "$STATUS" = "changed" ] || fail "an ordinary write did NOT wake the long-poll: $(cat "$POLL_OUT")"
rm -f "$POLL_OUT"
pass "ordinary write still wakes the long-poll (control)"

echo "OK: ~ keys broadcast and live in memory, but never persist and never bump the version"
