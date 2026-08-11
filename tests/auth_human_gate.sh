#!/usr/bin/env bash
# With the DingTalk gate ON (MinIO absent in tests, so we only assert the GATE,
# which runs BEFORE MinIO):
#   1. GET /pages/<key> with no session -> 302 to /auth/dingtalk/login?next=...
#   2. GET /pages/<key> with a valid forged session -> NOT 302 (gate passed;
#      then 503 because MinIO is unconfigured in tests).
set -uo pipefail
source "$(dirname "$0")/_lib.sh"

export DINGTALK_CLIENT_ID="testkey"
export DINGTALK_CLIENT_SECRET="testsecret"
export SESSION_SECRET="unit-secret"
export LIVEHTML_API_TOKEN="test-api-token"  # required when the DingTalk gate is on
start_server
BASE="http://127.0.0.1:$SERVER_PORT"

# 1. anonymous -> redirect to login
R=$(curl -sS -i "$BASE/pages/secret-doc")
echo "$R" | grep -qiE "^HTTP/[0-9.]+ 302" || fail "step1 expected 302, got: $(echo "$R" | head -1)"
echo "$R" | grep -qi "^location: /auth/dingtalk/login?next=" || fail "step1 wrong location: $R"
pass "step 1: anon page GET -> 302 login"

# 2. valid session in a real browser navigation -> gate passes
#    (MinIO missing => 503, NOT a 302 login)
SESS=$(mint_session "u1" "T" "$SESSION_SECRET")
NAV=(-H "Sec-Fetch-Site: same-origin" -H "Sec-Fetch-Mode: navigate" -H "Sec-Fetch-Dest: document")
CODE=$(curl -sS -o /dev/null -w "%{http_code}" --cookie "lh_sess=$SESS" "${NAV[@]}" "$BASE/pages/secret-doc")
[ "$CODE" != "302" ] || fail "step2 still redirected with valid session"
assert_eq 503 "$CODE" "step2 expected 503 (no minio) after gate, got $CODE"
pass "step 2: authed page GET passes gate (503 from missing minio)"

# 3. the same cookie shaped like a script request is NOT enough: the session
#    unlocks a page for a person, not for JS running inside another page.
CODE=$(curl -sS -o /dev/null -w "%{http_code}" --cookie "lh_sess=$SESS" \
  -H "Sec-Fetch-Site: same-origin" -H "Sec-Fetch-Mode: cors" -H "Sec-Fetch-Dest: empty" \
  "$BASE/pages/secret-doc")
assert_eq 401 "$CODE" "step3 a script-shaped request must not ride the cookie, got $CODE"
pass "step 3: script-shaped GET with the same cookie -> 401"

echo "OK: human page gate"
