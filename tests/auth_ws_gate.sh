#!/usr/bin/env bash
# WS room binding when the DingTalk gate is ON. A session cookie is no longer
# enough: the connection must present the room capability that the page GET
# injected, and that capability is for ONE room.
#   1. no session, no token            -> denied
#   2. valid session, NO token         -> denied  (the hole this closes: page JS
#                                        could otherwise ride the viewer's login
#                                        into any other page's room)
#   3. valid session + matching token  -> init, presence id = clientId, trusted name
#   4. token for room A used on room B -> denied
#   5. no session + matching token     -> init    (the public-page path)
#   6. authed peer still cannot spoof its presence name
set -uo pipefail
source "$(dirname "$0")/_lib.sh"

export DINGTALK_CLIENT_ID="testkey"
export DINGTALK_CLIENT_SECRET="testsecret"
export SESSION_SECRET="unit-secret"
export LIVEHTML_API_TOKEN="test-api-token"  # required when the DingTalk gate is on
start_server
BASE_WS="ws://127.0.0.1:$SERVER_PORT/ws"
ROOM="pages/secret"
SESS=$(mint_session "u7" "Seven" "$SESSION_SECRET")
TOK=$(mint_room_token "$ROOM" "" "$SESSION_SECRET")
TOK_OTHER=$(mint_room_token "pages/other" "" "$SESSION_SECRET")

# Bun WS client: connect, optionally send a Cookie header, send hi, print first frame.
# `done` is guarded against re-entry: ws.close() inside `done` synchronously
# re-dispatches the close event in Bun, so without the guard a received frame
# would be clobbered by a trailing "CLOSED". The first signal wins.
ws_first_frame() {  # $1 cookie-or-empty  $2 token-or-empty  $3 room
  COOKIE="$1" TOK="$2" ROOM="$3" WS="$BASE_WS" bun -e '
    const headers = process.env.COOKIE ? { Cookie: process.env.COOKIE } : {};
    const ws = new WebSocket(process.env.WS, { headers });
    let fired = false;
    const done = (s) => {
      if (fired) return;
      fired = true;
      console.log(s);
      try { ws.close(); } catch {}
      setTimeout(() => process.exit(0), 0);
    };
    ws.addEventListener("open", () => ws.send(JSON.stringify({
      t: "hi", room: process.env.ROOM, clientId: "cli-7", token: process.env.TOK || undefined,
    })));
    ws.addEventListener("message", (e) => done(String(e.data)));
    ws.addEventListener("close", () => done("CLOSED"));
    setTimeout(() => done("TIMEOUT"), 4000);
  '
}

OUT=$(ws_first_frame "" "" "$ROOM")
case "$OUT" in *'"t":"denied"'*|CLOSED) pass "step 1: no session, no token -> denied ($OUT)" ;; *) fail "step1 expected denied, got: $OUT" ;; esac

OUT=$(ws_first_frame "lh_sess=$SESS" "" "$ROOM")
case "$OUT" in
  *'"t":"init"'*) fail "step2 REGRESSION: a session cookie alone still joins a room — that is the cross-room hole: $OUT" ;;
  *'"t":"denied"'*|CLOSED) pass "step 2: session without the room capability -> denied ($OUT)" ;;
  *) fail "step2 unexpected: $OUT" ;;
esac

OUT=$(ws_first_frame "lh_sess=$SESS" "$TOK" "$ROOM")
echo "$OUT" | grep -q '"t":"init"'    || fail "step3 expected init, got: $OUT"
echo "$OUT" | grep -q '"you":"cli-7"' || fail "step3 presence id must equal clientId cli-7, got: $OUT"
echo "$OUT" | grep -q '"name":"Seven"' || fail "step3 trusted name Seven missing, got: $OUT"
pass "step 3: session + matching capability -> init (presence id = clientId, trusted name Seven)"

OUT=$(ws_first_frame "lh_sess=$SESS" "$TOK_OTHER" "$ROOM")
case "$OUT" in
  *'"t":"init"'*) fail "step4 a capability for pages/other opened $ROOM — the binding is not per-room: $OUT" ;;
  *'"t":"denied"'*|CLOSED) pass "step 4: a capability for another room -> denied ($OUT)" ;;
  *) fail "step4 unexpected: $OUT" ;;
esac

# Public pages hand an anonymous visitor the same capability, so they still join.
OUT=$(ws_first_frame "" "$TOK" "$ROOM")
echo "$OUT" | grep -q '"t":"init"' || fail "step5 anonymous + capability should join (public-page path), got: $OUT"
pass "step 5: no session + matching capability -> init (public-page path)"

# 6. An authed peer cannot spoof its presence name via a follow-up `pres`.
PRES_PEERS=$(COOKIE="lh_sess=$SESS" TOK="$TOK" ROOM="$ROOM" WS="$BASE_WS" bun -e '
  const ws = new WebSocket(process.env.WS, { headers: { Cookie: process.env.COOKIE } });
  let stage = 0, fired = false;
  const finish = (s) => { if (fired) return; fired = true; console.log(s); try { ws.close(); } catch {} setTimeout(() => process.exit(0), 0); };
  ws.addEventListener("open", () => ws.send(JSON.stringify({ t: "hi", room: process.env.ROOM, token: process.env.TOK })));
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(String(e.data));
    if (m.t === "init") { stage = 1; ws.send(JSON.stringify({ t: "pres", v: { name: "HACKER" } })); return; }
    if (m.t === "pres" && stage === 1) finish(JSON.stringify(m.peers));
  });
  setTimeout(() => finish("TIMEOUT"), 4000);
')
case "$PRES_PEERS" in
  *HACKER*) fail "step6 presence name was spoofed to HACKER: $PRES_PEERS" ;;
  *Seven*)  pass "step 6: authed pres cannot spoof name (still Seven)" ;;
  *)        fail "step6 unexpected pres peers: $PRES_PEERS" ;;
esac

echo "OK: the WS is bound to one room by a page-issued capability; a session alone opens nothing"
