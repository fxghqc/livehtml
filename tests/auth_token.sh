#!/usr/bin/env bash
# /auth/token minting + loopback redirect validation + refresh, with a forged
# session (no live DingTalk needed).
set -uo pipefail
source "$(dirname "$0")/_lib.sh"

export DINGTALK_CLIENT_ID="testkey"
export DINGTALK_CLIENT_SECRET="testsecret"
export SESSION_SECRET="unit-secret"
export LIVEHTML_API_TOKEN="static-tok"   # both gates on; either credential works
start_server
BASE="http://127.0.0.1:$SERVER_PORT"
SESS=$(mint_session "u1" "Alice" "$SESSION_SECRET")

# 1. format=json with a session -> a token + name
J=$(curl -sS --cookie "lh_sess=$SESS" "$BASE/auth/token?format=json")
case "$J" in *'"token":"'*'"name":"Alice"'*) pass "step 1: json mint" ;; *) fail "step1 body=$J" ;; esac
TOK=$(printf '%s' "$J" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
[ -n "$TOK" ] || fail "step1 no token extracted"

# 2. cli loopback -> 302 to that 127.0.0.1 url carrying token + nonce
R=$(curl -sS -i --cookie "lh_sess=$SESS" "$BASE/auth/token?cli=http%3A%2F%2F127.0.0.1%3A59999%2Fcb&n=abc123")
echo "$R" | grep -qiE "^HTTP/[0-9.]+ 302" || fail "step2 not 302: $(echo "$R" | head -1)"
echo "$R" | grep -qi "^location: http://127.0.0.1:59999/cb?token=" || fail "step2 wrong loopback loc: $R"
echo "$R" | grep -qi "n=abc123" || fail "step2 nonce not echoed"
pass "step 2: cli loopback redirect carries token + nonce"

# 3. cli with a NON-loopback target -> 400, no token
CODE=$(curl -sS -o /dev/null -w "%{http_code}" --cookie "lh_sess=$SESS" "$BASE/auth/token?cli=https%3A%2F%2Fevil.com%2Fcb")
assert_eq 400 "$CODE" "step3 external cli should be 400"
pass "step 3: external cli rejected"

# 4. no session -> 302 bounce to login
CODE=$(curl -sS -o /dev/null -w "%{http_code}" "$BASE/auth/token?format=json")
assert_eq 302 "$CODE" "step4 no-session should bounce to login"
pass "step 4: no session bounces to login"

# 5. refresh a valid token -> new token; garbage -> 401
J2=$(curl -sS -X POST -H "Authorization: Bearer $TOK" "$BASE/auth/token/refresh")
case "$J2" in *'"token":"'*'"name":"Alice"'*) pass "step 5a: refresh returns a token" ;; *) fail "step5a body=$J2" ;; esac
CODE=$(curl -sS -o /dev/null -w "%{http_code}" -X POST -H "Authorization: Bearer not.a.token" "$BASE/auth/token/refresh")
assert_eq 401 "$CODE" "step5b garbage refresh should be 401"
pass "step 5: refresh works / rejects garbage"

echo "OK: auth token mint + loopback + refresh"
