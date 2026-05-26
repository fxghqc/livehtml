#!/usr/bin/env bash
# B.V2 — wait=2 with no changes returns not_modified after ~2s.
#
# Pass: status="not_modified" AND 1700ms <= elapsed <= 3000ms
#       AND response has NO `state` field (saves bandwidth on the timeout path).

set -uo pipefail
source "$(dirname "$0")/_lib.sh"

start_server
BASE="http://127.0.0.1:$SERVER_PORT"
KEY="b-v2-$(date +%s)-$$"

# Bootstrap.
RESP=$(curl -sS "$BASE/pages/$KEY/state?wait=1")
ETAG=$(printf '%s' "$RESP" | jq -r .etag)
[ -n "$ETAG" ] && [ "$ETAG" != "null" ] || fail "bootstrap etag missing"

# Poll wait=2 idle.
T0=$(date +%s%N)
RESP=$(curl -sS -m 5 "$BASE/pages/$KEY/state?wait=2&since=$ETAG")
T1=$(date +%s%N)
ELAPSED_MS=$(( (T1 - T0) / 1000000 ))

STATUS=$(printf '%s' "$RESP" | jq -r .status)
HAS_STATE=$(printf '%s' "$RESP" | jq 'has("state")')

[ "$STATUS" = "not_modified" ] || fail "expected status=not_modified, got $STATUS (resp=$RESP)"
[ "$HAS_STATE" = "false" ] || fail "not_modified response should NOT include 'state' field (resp=$RESP)"
[ "$ELAPSED_MS" -ge 1700 ] && [ "$ELAPSED_MS" -le 3000 ] || fail "elapsed ${ELAPSED_MS}ms out of [1700,3000]"

pass "idle wait=2 returned not_modified in ${ELAPSED_MS}ms (no state body)"
echo "OK: idle long-poll times out cleanly"
