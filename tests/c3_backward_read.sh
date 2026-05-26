#!/usr/bin/env bash
# C.V3 — backward compat: a legacy flat-format state file on disk is read
# correctly. Format detection uses only the top-level `version` field, so
# a user's flat value that happens to look like {v, ts} is NOT mistaken
# for the envelope.
#
# Steps:
#   1. Write a flat-format file directly to rundir/state/ for KEY_FLAT
#   2. GET → flat values returned correctly
#   3. ?meta=1 → envelope shape with empty ts/by (no meta on disk)
#   4. PUT new state → next save upgrades the file to envelope
#   5. KEY_TRICKY: PUT a payload that contains a fields.x.v structure
#      INSIDE the user's flat state; round-trip preserves it (the
#      detection looks at top-level only)

set -uo pipefail
source "$(dirname "$0")/_lib.sh"

start_server
BASE="http://127.0.0.1:$SERVER_PORT"

# --- KEY_FLAT: legacy flat-format file already on disk ---
KEY_FLAT="c-v3-flat-$(date +%s)-$$"
SAFE_FLAT=$(printf '%s' "$KEY_FLAT" | tr '/' '_')
FILE_FLAT="$SERVER_RUNDIR/state/pages__${SAFE_FLAT}.json"
# Write the file BEFORE the first read so loadRoom picks it up off disk.
echo '{"legacy":true,"old":"value","count":7}' > "$FILE_FLAT"

# 1) GET → flat values
http GET "$BASE/pages/$KEY_FLAT/state"
assert_eq 200 "$HTTP_CODE" "flat GET status"
GOT=$(printf '%s' "$BODY" | jq -c .)
EXPECT='{"legacy":true,"old":"value","count":7}'
[ "$GOT" = "$EXPECT" ] || fail "legacy flat read mismatch: got $GOT want $EXPECT"
pass "step 1: legacy flat file returns flat values via GET"

# 2) ?meta=1 → envelope with empty meta
http GET "$BASE/pages/$KEY_FLAT/state?meta=1"
VER=$(printf '%s' "$BODY" | jq -r .version)
LEGACY_V=$(printf '%s' "$BODY" | jq -r '.fields.legacy.v')
LEGACY_TS=$(printf '%s' "$BODY" | jq -r '.fields.legacy.ts')
LEGACY_BY=$(printf '%s' "$BODY" | jq -r '.fields.legacy.by')
[ "$VER" = "2" ] || fail "legacy ?meta=1 version=$VER"
[ "$LEGACY_V" = "true" ] || fail "legacy ?meta=1 fields.legacy.v=$LEGACY_V"
[ "$LEGACY_TS" = "" ] || fail "legacy ?meta=1 fields.legacy.ts should be empty, got '$LEGACY_TS'"
[ "$LEGACY_BY" = "" ] || fail "legacy ?meta=1 fields.legacy.by should be empty, got '$LEGACY_BY'"
pass "step 2: legacy file → envelope shape with empty ts/by"

# 3) PUT upgrades the file on disk
http PUT "$BASE/pages/$KEY_FLAT/state" '{"upgraded":true,"keep":"ok"}'
assert_eq 200 "$HTTP_CODE" "upgrade PUT status"
sleep 0.6
NEW_VER=$(jq -r .version "$FILE_FLAT")
[ "$NEW_VER" = "2" ] || fail "after PUT, disk .version=$NEW_VER (want 2)"
UPGRADED_BY=$(jq -r '.fields.upgraded.by' "$FILE_FLAT")
[ "$UPGRADED_BY" = "http" ] || fail "upgraded key by=$UPGRADED_BY"
pass "step 3: write upgrades disk file to envelope"

# --- KEY_TRICKY: user value coincidentally shaped like envelope ---
KEY_TR="c-v3-tricky-$(date +%s)-$$"
PAYLOAD='{"version":7,"fields":{"x":{"v":1,"ts":"user-ts"}}}'
http PUT "$BASE/pages/$KEY_TR/state" "$PAYLOAD"
assert_eq 200 "$HTTP_CODE" "tricky PUT status"
sleep 0.6

# 4) Disk file is our envelope wrapping the user's data (NOT mistaken as theirs)
SAFE_TR=$(printf '%s' "$KEY_TR" | tr '/' '_')
FILE_TR="$SERVER_RUNDIR/state/pages__${SAFE_TR}.json"
OUR_VER=$(jq -r .version "$FILE_TR")
[ "$OUR_VER" = "2" ] || fail "tricky disk .version=$OUR_VER (want 2 — our envelope)"
# Their value lives inside fields.version.v and fields.fields.v
USER_VERSION_V=$(jq -r '.fields.version.v' "$FILE_TR")
USER_FIELDS_X_V=$(jq -r '.fields.fields.v.x.v' "$FILE_TR")
[ "$USER_VERSION_V" = "7" ] || fail "user's 'version' value lost: got $USER_VERSION_V"
[ "$USER_FIELDS_X_V" = "1" ] || fail "user's 'fields.x.v' value lost: got $USER_FIELDS_X_V"
pass "step 4: user values that look like envelope are wrapped, not interpreted"

# 5) GET round-trips the user's payload exactly
http GET "$BASE/pages/$KEY_TR/state"
GOT_TR=$(printf '%s' "$BODY" | jq -cS .)
EXPECT_TR=$(printf '%s' "$PAYLOAD" | jq -cS .)
[ "$GOT_TR" = "$EXPECT_TR" ] || fail "tricky round-trip mismatch:\n  got:    $GOT_TR\n  expect: $EXPECT_TR"
pass "step 5: tricky payload round-trips byte-equivalent (mod jq sort)"

echo "OK: backward read works; format detection is top-level-only"
