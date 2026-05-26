#!/usr/bin/env bash
# B.V5 — after server restart (new bootId), an old client's etag yields
# a `reset` response with the loaded state from disk and version=0.
#
# Pass:
#   - PUT some state under bootA, capture etag
#   - restart_server (kills + respawns in same rundir, so state file persists)
#   - poll with old etag -> status=reset, etag prefix != bootA, version=0,
#     state contains the persisted values

set -uo pipefail
source "$(dirname "$0")/_lib.sh"

start_server
BASE="http://127.0.0.1:$SERVER_PORT"
KEY="b-v5-$(date +%s)-$$"

# Phase 1 — write under server A and capture etag.
http PUT "$BASE/pages/$KEY/state" '{"persist":"yes","count":7}'
assert_eq 200 "$HTTP_CODE" "PUT failed under server A"

# Bootstrap etag under server A. Force it to advance past version 0 by
# doing another PUT, then poll for the changed event so we land on a
# matching version.
http PUT "$BASE/pages/$KEY/state" '{"persist":"yes","count":8}'
RESP=$(curl -sS "$BASE/pages/$KEY/state?wait=1")
OLD_ETAG=$(printf '%s' "$RESP" | jq -r .etag)
OLD_BOOT=$(printf '%s' "$OLD_ETAG" | cut -d: -f1)
[ -n "$OLD_BOOT" ] && [ "$OLD_BOOT" != "null" ] || fail "could not extract bootId from $OLD_ETAG"
pass "server A etag=$OLD_ETAG (boot=$OLD_BOOT)"

# scheduleSave debounces by 300ms; wait past that, then confirm disk.
sleep 0.6
STATE_FILE="$SERVER_RUNDIR/state/pages__$KEY.json"
[ -f "$STATE_FILE" ] || fail "expected state file $STATE_FILE to exist after PUT + debounce"
pass "state file persisted to disk"

# Phase 2 — restart and poll with the old etag.
restart_server
BASE="http://127.0.0.1:$SERVER_PORT"

RESP=$(curl -sS -m 5 "$BASE/pages/$KEY/state?wait=2&since=$OLD_ETAG")
STATUS=$(printf '%s' "$RESP" | jq -r .status)
NEW_ETAG=$(printf '%s' "$RESP" | jq -r .etag)
NEW_BOOT=$(printf '%s' "$NEW_ETAG" | cut -d: -f1)
NEW_VER=$(printf '%s' "$RESP" | jq -r .version)
STATE_COUNT=$(printf '%s' "$RESP" | jq -r .state.count)
STATE_PERSIST=$(printf '%s' "$RESP" | jq -r .state.persist)

[ "$STATUS" = "reset" ] || fail "expected status=reset, got $STATUS (resp=$RESP)"
[ "$NEW_BOOT" != "$OLD_BOOT" ] || fail "bootId should have changed across restart ($OLD_BOOT == $NEW_BOOT)"
[ "$NEW_VER" = "0" ] || fail "reset response should report version=0, got $NEW_VER"
[ "$STATE_COUNT" = "8" ] || fail "expected state.count=8 (loaded from disk), got $STATE_COUNT"
[ "$STATE_PERSIST" = "yes" ] || fail "expected state.persist=yes, got $STATE_PERSIST"

pass "old etag → reset with state loaded from disk (boot $OLD_BOOT → $NEW_BOOT, ver=0)"
echo "OK: restart yields reset semantics"
