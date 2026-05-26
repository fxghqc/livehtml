#!/usr/bin/env bash
# B.V4 — orchestrated sequence: watcher does 3 successive long-polls; writer
# does 3 PUTs at fixed intervals. Watcher must receive 3 `changed` responses
# in order with monotonically increasing versions.
#
# Pass: 3 responses, all status=changed, version[0] < version[1] < version[2].

set -uo pipefail
source "$(dirname "$0")/_lib.sh"

start_server
BASE="http://127.0.0.1:$SERVER_PORT"
KEY="b-v4-$(date +%s)-$$"

# Bootstrap etag.
BOOT=$(curl -sS "$BASE/pages/$KEY/state?wait=1")
ETAG=$(printf '%s' "$BOOT" | jq -r .etag)

WATCH_OUT=$(mktemp)

# Watcher: three sequential long-polls, each starts after previous returns.
{
  E="$ETAG"
  for i in 1 2 3; do
    R=$(curl -sS -m 12 "$BASE/pages/$KEY/state?wait=10&since=$E")
    printf '%s\n' "$R" >> "$WATCH_OUT"
    E=$(printf '%s' "$R" | jq -r .etag)
  done
} &
WATCH_PID=$!

# Let watcher register the first poll.
sleep 0.3

# Writer: 3 PUTs spaced ~1s apart.
( sleep 0.2; curl -sS -X PUT -H "Content-Type: application/json" -d '{"x":1}' "$BASE/pages/$KEY/state" >/dev/null
  sleep 1.0; curl -sS -X PUT -H "Content-Type: application/json" -d '{"x":2}' "$BASE/pages/$KEY/state" >/dev/null
  sleep 1.0; curl -sS -X PUT -H "Content-Type: application/json" -d '{"x":3}' "$BASE/pages/$KEY/state" >/dev/null
) &
WRITE_PID=$!

wait $WATCH_PID
wait $WRITE_PID

COUNT=$(wc -l < "$WATCH_OUT" | tr -d ' ')
[ "$COUNT" = "3" ] || fail "expected 3 watcher responses, got $COUNT (out=$(cat "$WATCH_OUT"))"

S1=$(sed -n 1p "$WATCH_OUT" | jq -r .status)
S2=$(sed -n 2p "$WATCH_OUT" | jq -r .status)
S3=$(sed -n 3p "$WATCH_OUT" | jq -r .status)
V1=$(sed -n 1p "$WATCH_OUT" | jq -r .version)
V2=$(sed -n 2p "$WATCH_OUT" | jq -r .version)
V3=$(sed -n 3p "$WATCH_OUT" | jq -r .version)

[ "$S1" = "changed" ] && [ "$S2" = "changed" ] && [ "$S3" = "changed" ] \
  || fail "expected statuses changed/changed/changed, got $S1/$S2/$S3"

[ "$V1" -lt "$V2" ] && [ "$V2" -lt "$V3" ] \
  || fail "versions not strictly increasing: $V1 < $V2 < $V3 failed"

# Final state in last response should reflect x=3.
LAST_X=$(sed -n 3p "$WATCH_OUT" | jq -r .state.x)
[ "$LAST_X" = "3" ] || fail "expected last state.x=3, got $LAST_X"

pass "3 changed responses, versions $V1<$V2<$V3, final x=$LAST_X"
rm -f "$WATCH_OUT"
echo "OK: orchestrated 3-PUT sequence delivered in order"
