#!/usr/bin/env bash
# With LIVEHTML_API_TOKEN set, agent/state HTTP surfaces require the bearer.
# Human/open surfaces stay open. (No MinIO needed: uses /state + /pages/<k>/state.)
set -uo pipefail
source "$(dirname "$0")/_lib.sh"

export LIVEHTML_API_TOKEN="tok-123"
start_server
BASE="http://127.0.0.1:$SERVER_PORT"

# state alias GET without token -> 401
CODE=$(curl -sS -o /dev/null -w "%{http_code}" "$BASE/pages/k1/state")
assert_eq 401 "$CODE" "state GET without token should be 401"

# with token -> 200
CODE=$(curl -sS -o /dev/null -w "%{http_code}" -H "Authorization: Bearer tok-123" "$BASE/pages/k1/state")
assert_eq 200 "$CODE" "state GET with token should be 200"

# /state/<room> PUT without token -> 401
CODE=$(curl -sS -o /dev/null -w "%{http_code}" -X PUT -H "Content-Type: application/json" --data '{"a":1}' "$BASE/state/room1")
assert_eq 401 "$CODE" "state PUT without token should be 401"

# /rooms without token -> 401
CODE=$(curl -sS -o /dev/null -w "%{http_code}" "$BASE/rooms")
assert_eq 401 "$CODE" "/rooms without token should be 401"

# open surface stays open: landing page
CODE=$(curl -sS -o /dev/null -w "%{http_code}" "$BASE/")
assert_eq 200 "$CODE" "landing page should stay open"

# /sync.js stays open
CODE=$(curl -sS -o /dev/null -w "%{http_code}" "$BASE/sync.js")
assert_eq 200 "$CODE" "/sync.js should stay open"

pass "all api-token assertions held"

# === gate active via DingTalk (no static token) accepts a signed api token ===
stop_server
export DINGTALK_CLIENT_ID="testkey"
export DINGTALK_CLIENT_SECRET="testsecret"
export SESSION_SECRET="unit-secret"
unset LIVEHTML_API_TOKEN
start_server
BASE="http://127.0.0.1:$SERVER_PORT"

# no token -> 401 (gate active because DingTalk is on)
CODE=$(curl -sS -o /dev/null -w "%{http_code}" "$BASE/pages/k9/state")
assert_eq 401 "$CODE" "dingtalk-only gate: no token should be 401"

# a signed api token (mint via the same HMAC the server uses) -> 200
API=$(mint_api_token "u3" "Cee" "$SESSION_SECRET")
CODE=$(curl -sS -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $API" "$BASE/pages/k9/state")
assert_eq 200 "$CODE" "dingtalk-only gate: signed token should be 200"
pass "signed per-user token satisfies the agent gate"

echo "OK: api token gate"
