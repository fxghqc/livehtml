# tests/auth_ws_gate.sh
#!/usr/bin/env bash
# WS hi-time gate when DingTalk gate is ON:
#   1. hi for a protected (non-page / private) room with NO session cookie -> "denied"
#   2. hi with a valid session cookie -> "init" (allowed) and `you` == uid
set -uo pipefail
source "$(dirname "$0")/_lib.sh"

export DINGTALK_CLIENT_ID="testkey"
export DINGTALK_CLIENT_SECRET="testsecret"
export SESSION_SECRET="unit-secret"
export LIVEHTML_API_TOKEN="test-api-token"  # required when the DingTalk gate is on
start_server
BASE_WS="ws://127.0.0.1:$SERVER_PORT/ws"
SESS=$(mint_session "u7" "Seven" "$SESSION_SECRET")

# Bun WS client: connect, optionally send a Cookie header, send hi, print first frame.
# `done` is guarded against re-entry: ws.close() inside `done` synchronously
# re-dispatches the close event in Bun, so without the guard a received frame
# would be clobbered by a trailing "CLOSED". The first signal wins.
ws_first_frame() {  # $1 cookie-or-empty
  COOKIE="$1" WS="$BASE_WS" bun -e '
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
    ws.addEventListener("open", () => ws.send(JSON.stringify({ t: "hi", room: "pages/secret" })));
    ws.addEventListener("message", (e) => done(String(e.data)));
    ws.addEventListener("close", () => done("CLOSED"));
    setTimeout(() => done("TIMEOUT"), 4000);
  '
}

OUT_ANON=$(ws_first_frame "")
case "$OUT_ANON" in *'"t":"denied"'*|CLOSED) pass "step 1: anon WS denied ($OUT_ANON)" ;; *) fail "step1 expected denied, got: $OUT_ANON" ;; esac

OUT_AUTH=$(ws_first_frame "lh_sess=$SESS")
case "$OUT_AUTH" in *'"t":"init"'*'"you":"u7"'*) pass "step 2: authed WS init with trusted you=u7" ;; *) fail "step2 expected init you=u7, got: $OUT_AUTH" ;; esac

# 3. An authed peer cannot spoof its presence name via a follow-up `pres`.
# Connect, send hi, then send pres{name:"HACKER"}; the broadcast pres frame
# (which includes the sender) must still show the trusted name "Seven".
PRES_PEERS=$(COOKIE="lh_sess=$SESS" WS="$BASE_WS" bun -e '
  const ws = new WebSocket(process.env.WS, { headers: { Cookie: process.env.COOKIE } });
  let stage = 0, fired = false;
  const finish = (s) => { if (fired) return; fired = true; console.log(s); try { ws.close(); } catch {} setTimeout(() => process.exit(0), 0); };
  ws.addEventListener("open", () => ws.send(JSON.stringify({ t: "hi", room: "pages/secret" })));
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(String(e.data));
    if (m.t === "init") { stage = 1; ws.send(JSON.stringify({ t: "pres", v: { name: "HACKER" } })); return; }
    if (m.t === "pres" && stage === 1) finish(JSON.stringify(m.peers));
  });
  setTimeout(() => finish("TIMEOUT"), 4000);
')
case "$PRES_PEERS" in
  *HACKER*) fail "step3 presence name was spoofed to HACKER: $PRES_PEERS" ;;
  *Seven*)  pass "step 3: authed pres cannot spoof name (still Seven)" ;;
  *)        fail "step3 unexpected pres peers: $PRES_PEERS" ;;
esac

echo "OK: ws gate"
