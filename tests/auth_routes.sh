#!/usr/bin/env bash
# Auth routes when the DingTalk gate is ENABLED (no live DingTalk needed):
#   1. GET /auth/me without cookie -> {authenticated:false}
#   2. GET /auth/dingtalk/login -> 302 to login.dingtalk.com with our params + state cookie
#   3. GET /auth/me with a forged-but-valid lh_sess cookie -> authenticated identity
#   4. GET /auth/logout -> 302 and clears the cookie
set -uo pipefail
source "$(dirname "$0")/_lib.sh"

export DINGTALK_CLIENT_ID="testkey"
export DINGTALK_CLIENT_SECRET="testsecret"
export SESSION_SECRET="unit-secret"
start_server
BASE="http://127.0.0.1:$SERVER_PORT"

# 1. /auth/me anonymous
http GET "$BASE/auth/me"
assert_eq 200 "$HTTP_CODE" "me anon status"
case "$BODY" in *'"authenticated":false'*) pass "step 1: anon me" ;; *) fail "step1 body=$BODY" ;; esac

# 2. login redirect
LOGIN=$(curl -sS -i "$BASE/auth/dingtalk/login?next=%2Fpages%2Fabc")
echo "$LOGIN" | grep -qi "^location: https://login.dingtalk.com/oauth2/auth" || fail "step2 no authorize redirect: $LOGIN"
echo "$LOGIN" | grep -qi "client_id=testkey" || fail "step2 missing client_id"
echo "$LOGIN" | grep -qi "redirect_uri=" || fail "step2 missing redirect_uri"
echo "$LOGIN" | grep -qi "^set-cookie: lh_oauth=" || fail "step2 missing oauth state cookie"
pass "step 2: login 302 + state cookie"

# 3. forged valid session
SESS=$(mint_session "u42" "Tester" "$SESSION_SECRET")
http_with_cookie() { BODY=$(curl -sS -w "\n%{http_code}" --cookie "$1" "$2"); HTTP_CODE=$(printf '%s' "$BODY" | tail -n1); BODY=$(printf '%s' "$BODY" | sed '$d'); }
http_with_cookie "lh_sess=$SESS" "$BASE/auth/me"
assert_eq 200 "$HTTP_CODE" "me authed status"
case "$BODY" in *'"authenticated":true'*'"userId":"u42"'*) pass "step 3: authed me" ;; *) fail "step3 body=$BODY" ;; esac

# 4. logout
LOGOUT=$(curl -sS -i "$BASE/auth/logout")
echo "$LOGOUT" | grep -qi "^set-cookie: lh_sess=" || fail "step4 no clear cookie"
echo "$LOGOUT" | grep -qi "max-age=0" || fail "step4 cookie not expired"
pass "step 4: logout clears cookie"

echo "OK: auth routes"
