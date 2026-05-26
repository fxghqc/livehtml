#!/usr/bin/env bash
# C.V2 — ?meta=1 returns the envelope from the API; default GET still flat.
# Both alias path and legacy /state/<room> path honor ?meta=1.
# After WS-style writes (simulated via WS-equivalent HTTP), `by` reflects
# the write source.

set -uo pipefail
source "$(dirname "$0")/_lib.sh"

start_server
BASE="http://127.0.0.1:$SERVER_PORT"
KEY="c-v2-$(date +%s)-$$"

# Seed via HTTP PUT.
http PUT "$BASE/pages/$KEY/state" '{"x":42,"name":"alice"}'
assert_eq 200 "$HTTP_CODE" "PUT failed"

# 1) default flat on alias
http GET "$BASE/pages/$KEY/state"
assert_eq 200 "$HTTP_CODE" "alias GET status"
[ "$BODY" = '{"x":42,"name":"alice"}' ] || fail "alias default GET not flat: $BODY"
pass "alias default GET is flat"

# 2) ?meta=1 on alias returns envelope
http GET "$BASE/pages/$KEY/state?meta=1"
assert_eq 200 "$HTTP_CODE" "alias meta GET status"
VERSION=$(printf '%s' "$BODY" | jq -r .version)
X_V=$(printf '%s' "$BODY" | jq -r '.fields.x.v')
X_BY=$(printf '%s' "$BODY" | jq -r '.fields.x.by')
X_TS=$(printf '%s' "$BODY" | jq -r '.fields.x.ts')
NAME_V=$(printf '%s' "$BODY" | jq -r '.fields.name.v')
[ "$VERSION" = "2" ] || fail "alias ?meta=1 .version=$VERSION"
[ "$X_V" = "42" ] || fail "alias ?meta=1 fields.x.v=$X_V"
[ "$NAME_V" = "alice" ] || fail "alias ?meta=1 fields.name.v=$NAME_V"
[ "$X_BY" = "http" ] || fail "alias ?meta=1 fields.x.by=$X_BY"
printf '%s' "$X_TS" | grep -qE '^[0-9]{4}-' || fail "alias ?meta=1 fields.x.ts invalid: $X_TS"
pass "alias ?meta=1 returns envelope with ts/by per key"

# 3) ?meta=1 on legacy /state/<room> too (handleStateRoom is shared)
http GET "$BASE/state/pages/$KEY?meta=1"
assert_eq 200 "$HTTP_CODE" "legacy meta GET status"
VERSION2=$(printf '%s' "$BODY" | jq -r .version)
X_V2=$(printf '%s' "$BODY" | jq -r '.fields.x.v')
[ "$VERSION2" = "2" ] && [ "$X_V2" = "42" ] \
  || fail "legacy ?meta=1 mismatch: version=$VERSION2 x.v=$X_V2"
pass "legacy /state/<room>?meta=1 also returns envelope"

# 4) default GET on legacy still flat (regression of V1 alias guarantee)
http GET "$BASE/state/pages/$KEY"
assert_eq 200 "$HTTP_CODE" "legacy default GET status"
[ "$BODY" = '{"x":42,"name":"alice"}' ] || fail "legacy default GET not flat: $BODY"
pass "legacy default GET still flat"

# 5) ?meta=1 reflects added/removed keys after another PUT
http PUT "$BASE/pages/$KEY/state" '{"only":1}'
assert_eq 200 "$HTTP_CODE" "second PUT failed"
http GET "$BASE/pages/$KEY/state?meta=1"
KEYS=$(printf '%s' "$BODY" | jq -r '.fields | keys | join(",")')
[ "$KEYS" = "only" ] || fail "after replace PUT, fields keys should be 'only', got '$KEYS'"
pass "?meta=1 reflects key set after replace PUT"

echo "OK: ?meta=1 envelope works on both routes; default stays flat"
