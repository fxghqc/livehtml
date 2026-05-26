#!/usr/bin/env bash
# Demo regression smoke — exercises the plumbing demo.html depends on, without
# needing a real browser. Covers:
#   1. /examples/demo.html served, contains data-live attributes
#   2. /sync.js served
#   3. WebSocket hi/init flow works (joins room "demo", receives state)
#   4. ws `set` message → state file on disk has the new value
#   5. ws `del` message → state file updates
#   6. Reconnect → init still shows the value (persistence works)
#   7. broadcast — second client sees first client's `set`
#
# This is the automated equivalent of "open demo in two browsers, click, verify".
# The actual DOM binding code (public/sync.js) is unchanged by Phase A, so a
# wiring test is sufficient to prove demo.html's pathway is intact.

set -uo pipefail
source "$(dirname "$0")/_lib.sh"

start_server

BASE="http://127.0.0.1:$SERVER_PORT"

# Step 1: demo.html served and has data-live.
http GET "$BASE/examples/demo.html"
assert_eq 200 "$HTTP_CODE" "demo.html GET returned $HTTP_CODE"
if ! printf '%s' "$BODY" | grep -q 'data-live="task-1"'; then
  fail "demo.html missing data-live=\"task-1\" attribute"
fi
pass "step 1: /examples/demo.html serves, has data-live"

# Step 2: sync.js served.
http GET "$BASE/sync.js"
assert_eq 200 "$HTTP_CODE" "sync.js GET returned $HTTP_CODE"
if ! printf '%s' "$BODY" | grep -q 'LiveHtml'; then
  fail "sync.js doesn't look like the right script"
fi
pass "step 2: /sync.js serves"

# Steps 3-7: drive WS via a small bun script.
WS_DRIVER="$(mktemp -t livehtml-ws-XXXXXX.ts)"
trap 'rm -f "$WS_DRIVER"' RETURN
cat >"$WS_DRIVER" <<'EOF'
const URL = process.env.WS_URL!;
const KEY = process.env.TEST_KEY!;
const STATE_URL = process.env.STATE_URL!;

function open(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(e);
  });
}

function waitMsg(ws: WebSocket, predicate: (m: any) => boolean, timeoutMs = 2000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("waitMsg timeout")), timeoutMs);
    const handler = (ev: MessageEvent) => {
      let msg: any;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.removeEventListener("message", handler as any);
        resolve(msg);
      }
    };
    ws.addEventListener("message", handler as any);
  });
}

async function fetchState(): Promise<any> {
  const r = await fetch(STATE_URL);
  return r.json();
}

async function main() {
  // Step 3: connect, send hi, expect init.
  const w1 = await open();
  w1.send(JSON.stringify({ t: "hi", room: "demo", clientId: "test-client-1", user: { name: "tester1" } }));
  const init1 = await waitMsg(w1, (m) => m.t === "init");
  if (init1.room !== "demo") throw new Error(`init.room=${init1.room}`);
  console.log("step3:ok");

  // Step 4: set key, wait for save, verify state file.
  w1.send(JSON.stringify({ t: "set", key: KEY, v: "alpha" }));
  // server debounces save by 300ms; wait a bit longer
  await new Promise((r) => setTimeout(r, 500));
  let s = await fetchState();
  if (s[KEY] !== "alpha") throw new Error(`step4: state[${KEY}]=${JSON.stringify(s[KEY])}`);
  console.log("step4:ok");

  // Step 5: del key, verify gone.
  w1.send(JSON.stringify({ t: "del", key: KEY }));
  await new Promise((r) => setTimeout(r, 500));
  s = await fetchState();
  if (KEY in s) throw new Error(`step5: key still present after del`);
  console.log("step5:ok");

  // Step 6: set + reconnect, init shows it.
  w1.send(JSON.stringify({ t: "set", key: KEY, v: "beta" }));
  await new Promise((r) => setTimeout(r, 500));
  w1.close();
  await new Promise((r) => setTimeout(r, 100));
  const w2 = await open();
  w2.send(JSON.stringify({ t: "hi", room: "demo", clientId: "test-client-2", user: { name: "tester2" } }));
  const init2 = await waitMsg(w2, (m) => m.t === "init");
  if (init2.state?.[KEY] !== "beta") throw new Error(`step6: reconnect init missing key, got ${JSON.stringify(init2.state)}`);
  console.log("step6:ok");

  // Step 7: open third client, set via w2, w3 receives broadcast.
  const w3 = await open();
  w3.send(JSON.stringify({ t: "hi", room: "demo", clientId: "test-client-3", user: { name: "tester3" } }));
  await waitMsg(w3, (m) => m.t === "init");
  const broadcastP = waitMsg(w3, (m) => m.t === "set" && m.key === KEY);
  w2.send(JSON.stringify({ t: "set", key: KEY, v: "gamma" }));
  const got = await broadcastP;
  if (got.v !== "gamma") throw new Error(`step7: broadcast v=${got.v}`);
  console.log("step7:ok");

  w2.close();
  w3.close();
}

main().then(() => { console.log("DONE"); process.exit(0); })
      .catch((e) => { console.error("FAIL:", e); process.exit(1); });
EOF

KEY="demo-smoke-$(date +%s)-$$"
DRIVER_OUT=$(WS_URL="ws://127.0.0.1:$SERVER_PORT/ws" \
             TEST_KEY="$KEY" \
             STATE_URL="$BASE/state/demo" \
             bun "$WS_DRIVER" 2>&1) || {
  echo "$DRIVER_OUT" >&2
  fail "ws driver script failed"
}
echo "$DRIVER_OUT"

# Sanity: each step printed ok.
for n in 3 4 5 6 7; do
  if ! printf '%s' "$DRIVER_OUT" | grep -q "step$n:ok"; then
    fail "ws driver missing step$n:ok marker"
  fi
done
pass "steps 3-7: WS hi/init/set/del + persistence + broadcast"

echo "OK: demo.html plumbing intact"
