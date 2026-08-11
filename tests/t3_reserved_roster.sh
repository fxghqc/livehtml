#!/usr/bin/env bash
# `__users`: the server-owned roster of everyone who signed in to a room.
#   1. an authenticated WS peer is recorded (uid -> trusted name)
#   2. a browser cannot write a `__` key over WS
#   3. an HTTP whole-state PUT/DELETE can neither overwrite nor drop the roster

set -uo pipefail
source "$(dirname "$0")/_lib.sh"

export DINGTALK_CLIENT_ID="testkey"
export DINGTALK_CLIENT_SECRET="testsecret"
export SESSION_SECRET="unit-secret"
export LIVEHTML_API_TOKEN="test-api-token"  # required when the DingTalk gate is on
start_server
BASE="http://127.0.0.1:$SERVER_PORT"
WS="ws://127.0.0.1:$SERVER_PORT/ws"
KEY="t3-$(date +%s)-$$"
ROOM="pages/$KEY"
AUTH=(-H "Authorization: Bearer $LIVEHTML_API_TOKEN")

# Connect with a session cookie + the room capability, print the init frame,
# then send the given ops.
ws_hi_ops() { # $1 room  $2 cookie  $3 JSON array of ops
  ROOM="$1" COOKIE="$2" OPS="$3" TOK="$(mint_room_token "$1" "" "$SESSION_SECRET")" WS="$WS" bun -e '
    const ws = new WebSocket(process.env.WS, { headers: { Cookie: process.env.COOKIE } });
    const ops = JSON.parse(process.env.OPS);
    let fired = false;
    const done = (s) => { if (fired) return; fired = true; console.log(s); try { ws.close(); } catch {} setTimeout(() => process.exit(0), 0); };
    ws.addEventListener("open", () => ws.send(JSON.stringify({ t: "hi", room: process.env.ROOM, token: process.env.TOK })));
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(String(e.data));
      if (m.t !== "init") return;
      for (const op of ops) ws.send(JSON.stringify(op));
      setTimeout(() => done(JSON.stringify(m)), 300);
    });
    setTimeout(() => done("TIMEOUT"), 5000);
  '
}

state_json() { curl -sS "${AUTH[@]}" "$BASE/pages/$KEY/state"; }

# 1. First peer: the roster starts empty and gains u7 on connect, so its own
#    init already carries it.
SESS7=$(mint_session "u7" "Seven" "$SESSION_SECRET")
INIT7=$(ws_hi_ops "$ROOM" "lh_sess=$SESS7" '[]')
echo "$INIT7" | grep -q '"__users"' || fail "init has no roster: $INIT7"
NAME7=$(printf '%s' "$INIT7" | jq -r '.state.__users.u7')
[ "$NAME7" = "Seven" ] || fail "roster missing u7->Seven: $INIT7"
pass "an authenticated peer is recorded in __users with its trusted name"

# 2. Second peer, plus a hand-crafted attempt to overwrite the roster over WS.
SESS8=$(mint_session "u8" "Eight" "$SESSION_SECRET")
ws_hi_ops "$ROOM" "lh_sess=$SESS8" '[{"t":"set","key":"__users","v":{"evil":"x"}},{"t":"set","key":"vote:u8","v":"A"}]' >/dev/null

BODY=$(state_json)
U7=$(printf '%s' "$BODY" | jq -r '.__users.u7')
U8=$(printf '%s' "$BODY" | jq -r '.__users.u8')
EVIL=$(printf '%s' "$BODY" | jq -r '.__users | has("evil")')
VOTE=$(printf '%s' "$BODY" | jq -r '."vote:u8"')
[ "$U7" = "Seven" ] && [ "$U8" = "Eight" ] || fail "roster lost a member: $BODY"
[ "$EVIL" = "false" ] || fail "a browser wrote the reserved __users key: $BODY"
[ "$VOTE" = "A" ] || fail "the ordinary write in the same batch was dropped: $BODY"
pass "browser writes to __ keys are refused; ordinary writes in the same batch still land"

# 3. A whole-state PUT can neither set nor drop the roster.
curl -sS "${AUTH[@]}" -X PUT -H 'Content-Type: application/json' \
  --data '{"x":1,"__users":{"evil":"x"}}' "$BASE/pages/$KEY/state" >/dev/null
BODY=$(state_json)
X=$(printf '%s' "$BODY" | jq -r '.x')
U7=$(printf '%s' "$BODY" | jq -r '.__users.u7')
EVIL=$(printf '%s' "$BODY" | jq -r '.__users | has("evil")')
[ "$X" = "1" ] || fail "PUT did not replace ordinary state: $BODY"
[ "$U7" = "Seven" ] && [ "$EVIL" = "false" ] || fail "PUT overwrote the roster: $BODY"
pass "HTTP PUT replaces ordinary state and carries the roster through untouched"

# 4. Clearing the room keeps it — the roster is the server's, not the page's.
curl -sS "${AUTH[@]}" -X DELETE "$BASE/pages/$KEY/state" >/dev/null
BODY=$(state_json)
HAS_X=$(printf '%s' "$BODY" | jq -r 'has("x")')
U7=$(printf '%s' "$BODY" | jq -r '.__users.u7')
[ "$HAS_X" = "false" ] || fail "DELETE did not clear ordinary state: $BODY"
[ "$U7" = "Seven" ] || fail "DELETE dropped the roster: $BODY"
pass "clearing the room keeps __users"

echo "OK: __users is server-owned — recorded on connect, unwritable by pages, retained across replaces"
