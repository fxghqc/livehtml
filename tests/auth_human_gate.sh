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
start_server
BASE="http://127.0.0.1:$SERVER_PORT"

# 1. anonymous -> redirect to login
R=$(curl -sS -i "$BASE/pages/secret-doc")
echo "$R" | grep -qiE "^HTTP/[0-9.]+ 302" || fail "step1 expected 302, got: $(echo "$R" | head -1)"
echo "$R" | grep -qi "^location: /auth/dingtalk/login?next=" || fail "step1 wrong location: $R"
pass "step 1: anon page GET -> 302 login"

# 2. valid session -> gate passes (MinIO missing => 503, NOT a 302 login)
SESS=$(mint_session "u1" "T" "$SESSION_SECRET")
CODE=$(curl -sS -o /dev/null -w "%{http_code}" --cookie "lh_sess=$SESS" "$BASE/pages/secret-doc")
[ "$CODE" != "302" ] || fail "step2 still redirected with valid session"
assert_eq 503 "$CODE" "step2 expected 503 (no minio) after gate, got $CODE"
pass "step 2: authed page GET passes gate (503 from missing minio)"

echo "OK: human page gate"
