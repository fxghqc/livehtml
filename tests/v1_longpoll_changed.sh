#!/usr/bin/env bash
# B.V1 — long-poll wakes within <1s when a PUT lands on the same key.
#
# Setup: server fresh, currentVer=0. Bootstrap GET wait=1 with no since
# returns reset with etag <bootId>:0. Polling with that etag matches
# currentVer, so the server parks the request.
#
# Pass: status="changed" AND elapsed (from PUT to response) < 1000ms.

set -uo pipefail
source "$(dirname "$0")/_lib.sh"

start_server
BASE="http://127.0.0.1:$SERVER_PORT"
KEY="b-v1-$(date +%s)-$$"

# Bootstrap etag.
RESP=$(curl -sS "$BASE/pages/$KEY/state?wait=1")
ETAG=$(printf '%s' "$RESP" | jq -r .etag)
[ -n "$ETAG" ] && [ "$ETAG" != "null" ] || fail "bootstrap etag missing: $RESP"
pass "bootstrap: etag=$ETAG"

# Start long-poll in background; capture output and wall time.
POLL_OUT=$(mktemp)
POLL_TIME=$(mktemp)
{ /usr/bin/time -p curl -sS -m 15 "$BASE/pages/$KEY/state?wait=10&since=$ETAG" >"$POLL_OUT" ; } 2>"$POLL_TIME" &
POLL_PID=$!

# Let the poll register as a waiter.
sleep 0.3

# Trigger a write — measure latency from here.
T0=$(date +%s%N)
http PUT "$BASE/pages/$KEY/state" '{"foo":1}'
assert_eq 200 "$HTTP_CODE" "PUT returned $HTTP_CODE"

# Wait for the poll to return.
wait $POLL_PID
T1=$(date +%s%N)

ELAPSED_MS=$(( (T1 - T0) / 1000000 ))
RESP=$(cat "$POLL_OUT")
STATUS=$(printf '%s' "$RESP" | jq -r .status)
VER=$(printf '%s' "$RESP" | jq -r .version)
STATE_FOO=$(printf '%s' "$RESP" | jq -r .state.foo)

[ "$STATUS" = "changed" ] || fail "expected status=changed, got $STATUS (resp=$RESP)"
[ "$VER" -gt 0 ] || fail "expected version > 0, got $VER"
[ "$STATE_FOO" = "1" ] || fail "expected state.foo=1, got $STATE_FOO"
[ "$ELAPSED_MS" -lt 1000 ] || fail "long-poll took ${ELAPSED_MS}ms (want <1000ms)"

pass "long-poll woke in ${ELAPSED_MS}ms with status=changed, version=$VER"
rm -f "$POLL_OUT" "$POLL_TIME"
echo "OK: long-poll wakes on same-key PUT within 1s"
