#!/usr/bin/env bash
# A.V1 — `/pages/<key>/state` is byte-level equivalent to `/state/pages/<key>`.
#
# Pass criteria (all must hold; first failure exits non-zero):
#   1. PUT via old path, GET via both → bodies byte-identical
#   2. PUT via new path, GET via both → bodies byte-identical
#   3. PUT via new path returns the same room id as old path would
#   4. DELETE via new path clears state visible from old path
#   5. PUT with invalid JSON body returns 400 on both paths
#   6. PUT with array body returns 400 on both paths
#   7. GET of unknown key returns "{}" on both paths

set -uo pipefail
source "$(dirname "$0")/_lib.sh"

start_server

KEY="v1-test-$(date +%s)-$$"
OLD="http://127.0.0.1:$SERVER_PORT/state/pages/$KEY"
NEW="http://127.0.0.1:$SERVER_PORT/pages/$KEY/state"

# Step 1: PUT via OLD, compare GETs.
S1='{"task-1":true,"note":"hello","score":42,"nested":{"a":[1,2,3]}}'
http PUT "$OLD" "$S1"
assert_eq 200 "$HTTP_CODE" "step1 PUT old returned $HTTP_CODE"

http GET "$OLD"
RESP_OLD="$BODY"
http GET "$NEW"
RESP_NEW="$BODY"
assert_eq "$RESP_OLD" "$RESP_NEW" "step1 GET old vs new not byte-identical"
pass "step 1: PUT old, GET old/new identical"

# Step 2: PUT via NEW, compare GETs.
S2='{"updated":true,"task-1":false,"list":["a","b"]}'
http PUT "$NEW" "$S2"
assert_eq 200 "$HTTP_CODE" "step2 PUT new returned $HTTP_CODE"

http GET "$OLD"
RESP_OLD="$BODY"
http GET "$NEW"
RESP_NEW="$BODY"
assert_eq "$RESP_OLD" "$RESP_NEW" "step2 GET old vs new not byte-identical"
pass "step 2: PUT new, GET old/new identical"

# Step 3: PUT response shape — both paths should report room="pages/<key>".
EXPECTED_ROOM="pages/$KEY"
http PUT "$OLD" '{}'
ROOM_OLD=$(printf '%s' "$BODY" | grep -o '"room":"[^"]*"' | head -1)
http PUT "$NEW" '{}'
ROOM_NEW=$(printf '%s' "$BODY" | grep -o '"room":"[^"]*"' | head -1)
assert_eq "\"room\":\"$EXPECTED_ROOM\"" "$ROOM_OLD" "old PUT room mismatch"
assert_eq "\"room\":\"$EXPECTED_ROOM\"" "$ROOM_NEW" "new PUT room mismatch"
pass "step 3: PUT responses agree on room id"

# Step 4: DELETE via NEW, both GETs return {}.
http PUT "$NEW" '{"keep":1}'
assert_eq 200 "$HTTP_CODE" "step4 setup PUT failed"
http DELETE "$NEW"
assert_eq 200 "$HTTP_CODE" "step4 DELETE new returned $HTTP_CODE"
http GET "$OLD"
assert_eq "{}" "$BODY" "step4 GET old after DELETE not empty"
http GET "$NEW"
assert_eq "{}" "$BODY" "step4 GET new after DELETE not empty"
pass "step 4: DELETE via new clears state visible from old"

# Step 5: Invalid JSON body → 400 on both.
http PUT "$OLD" 'not json'
assert_eq 400 "$HTTP_CODE" "step5 old invalid-json expected 400 got $HTTP_CODE"
http PUT "$NEW" 'not json'
assert_eq 400 "$HTTP_CODE" "step5 new invalid-json expected 400 got $HTTP_CODE"
pass "step 5: invalid JSON → 400 on both"

# Step 6: Array body → 400 on both.
http PUT "$OLD" '[1,2,3]'
assert_eq 400 "$HTTP_CODE" "step6 old array expected 400 got $HTTP_CODE"
http PUT "$NEW" '[1,2,3]'
assert_eq 400 "$HTTP_CODE" "step6 new array expected 400 got $HTTP_CODE"
pass "step 6: array body → 400 on both"

# Step 7: GET unknown key → {}.
NEW_KEY="unknown-$(date +%s)-$$"
http GET "http://127.0.0.1:$SERVER_PORT/state/pages/$NEW_KEY"
assert_eq 200 "$HTTP_CODE" "step7 old GET unknown returned $HTTP_CODE"
assert_eq "{}" "$BODY" "step7 old GET unknown body != {}"
http GET "http://127.0.0.1:$SERVER_PORT/pages/$NEW_KEY/state"
assert_eq 200 "$HTTP_CODE" "step7 new GET unknown returned $HTTP_CODE"
assert_eq "{}" "$BODY" "step7 new GET unknown body != {}"
pass "step 7: unknown key → {}"

echo "OK: all 7 steps passed for /pages/<key>/state alias"
