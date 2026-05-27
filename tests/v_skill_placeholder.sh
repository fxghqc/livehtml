#!/usr/bin/env bash
# Skill placeholder substitution: when SKILL.md is fetched via /skill/SKILL.md,
# the literal `LIVEHTML_BASE_URL` placeholder should be replaced with the
# protocol+host the client used. Same for any other file under /skill/.
#
# This lets agents installed via `curl <host>/install | sh` receive a
# SKILL.md whose URLs already point at their own deployment, instead of
# the upstream repo's hardcoded IP.
#
# Pass:
#   - source file in skill/ contains the literal placeholder
#   - response from /skill/SKILL.md does NOT contain the placeholder
#   - response contains the expected http://127.0.0.1:<port> base
#   - same substitution applied to evals.json

set -uo pipefail
source "$(dirname "$0")/_lib.sh"

start_server
BASE="http://127.0.0.1:$SERVER_PORT"

# Sanity: the on-disk source has the placeholder.
SRC="$REPO_ROOT/skill/SKILL.md"
grep -q 'LIVEHTML_BASE_URL' "$SRC" \
  || fail "skill/SKILL.md should contain LIVEHTML_BASE_URL placeholder in source"
pass "source skill/SKILL.md has placeholder"

# Fetch via the route — should have the placeholder substituted.
http GET "$BASE/skill/SKILL.md"
assert_eq 200 "$HTTP_CODE" "/skill/SKILL.md status"
if printf '%s' "$BODY" | grep -q 'LIVEHTML_BASE_URL'; then
  fail "served /skill/SKILL.md still contains placeholder LIVEHTML_BASE_URL"
fi
if ! printf '%s' "$BODY" | grep -qF "$BASE"; then
  fail "served /skill/SKILL.md does not contain expected base $BASE"
fi
pass "/skill/SKILL.md placeholder replaced with $BASE"

# Same substitution must work on evals.json.
http GET "$BASE/skill/evals/evals.json"
assert_eq 200 "$HTTP_CODE" "/skill/evals/evals.json status"
if printf '%s' "$BODY" | grep -q 'LIVEHTML_BASE_URL'; then
  fail "served evals.json still contains placeholder"
fi
if ! printf '%s' "$BODY" | grep -qF "$BASE"; then
  fail "served evals.json does not contain expected base $BASE"
fi
pass "/skill/evals/evals.json placeholder replaced with $BASE"

# Path-traversal guard.
http GET "$BASE/skill/..%2F..%2Fserver.ts"
[ "$HTTP_CODE" = "404" ] || fail "path traversal should 404, got $HTTP_CODE"
pass "path traversal blocked"

# Unknown file 404.
http GET "$BASE/skill/no-such-file.md"
[ "$HTTP_CODE" = "404" ] || fail "unknown skill file should 404, got $HTTP_CODE"
pass "unknown skill file 404"

echo "OK: skill placeholder substitution + path safety"
