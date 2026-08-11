#!/usr/bin/env bash
# End-to-end over MinIO, with the login gate on:
#   1. PUT a page -> the served HTML carries exactly one sync.js tag (the
#      server's), with data-room + data-token; the page's own tag is stripped
#   2. that injected capability is what opens the WS
#   3. a room declared with X-Read-Rooms streams into the page read-only
#   4. the reader's writes land in ITS OWN room, never in the room it reads
#
# Skips (exit 0) when no MinIO is reachable — override with LIVEHTML_TEST_MINIO.

set -uo pipefail
source "$(dirname "$0")/_lib.sh"

MINIO_AT="${LIVEHTML_TEST_MINIO:-127.0.0.1:9000}"
if ! curl -sf -o /dev/null "http://$MINIO_AT/minio/health/live"; then
  echo "SKIP: no MinIO at $MINIO_AT (set LIVEHTML_TEST_MINIO=host:port to run this)"
  exit 0
fi

export MINIO_ENDPOINT="$MINIO_AT"
export MINIO_ACCESS_KEY="${LIVEHTML_TEST_MINIO_KEY:-k2data}"
export MINIO_SECRET_KEY="${LIVEHTML_TEST_MINIO_SECRET:-K2data1234}"
export MINIO_BUCKET="livehtml-test-$$"
export DINGTALK_CLIENT_ID="testkey"
export DINGTALK_CLIENT_SECRET="testsecret"
export SESSION_SECRET="unit-secret"
export LIVEHTML_API_TOKEN="test-api-token"

# The server creates the bucket on boot; drop it (and anything in it) on the
# way out so repeated runs don't accumulate buckets in a shared dev MinIO.
cleanup_bucket() {
  bun -e '
    const { Client } = await import("minio");
    const [host, port] = (process.env.MINIO_ENDPOINT || "").split(":");
    const c = new Client({ endPoint: host, port: Number(port || 9000), useSSL: false,
      accessKey: process.env.MINIO_ACCESS_KEY, secretKey: process.env.MINIO_SECRET_KEY });
    const b = process.env.MINIO_BUCKET;
    try {
      const names = [];
      for await (const o of c.listObjectsV2(b, "", true)) if (o.name) names.push(o.name);
      if (names.length) await c.removeObjects(b, names);
      await c.removeBucket(b);
    } catch {}
  ' >/dev/null 2>&1 || true
}

start_server
trap 'stop_server; cleanup_bucket' EXIT INT TERM

BASE="http://127.0.0.1:$SERVER_PORT"
WS="ws://127.0.0.1:$SERVER_PORT/ws"
STAMP="t4-$(date +%s)-$$"
KEY_A="$STAMP/board"
KEY_B="$STAMP/source"
ROOM_A="pages/$KEY_A"
ROOM_B="pages/$KEY_B"
SESS=$(mint_session "u7" "Seven" "$SESSION_SECRET")
AUTH=(-H "Authorization: Bearer $LIVEHTML_API_TOKEN")

# --- publish the source page and seed its state ---
printf '<html><head></head><body><input data-live="n"></body></html>' >"$SERVER_RUNDIR/b.html"
curl -sS "${AUTH[@]}" -X PUT --data-binary "@$SERVER_RUNDIR/b.html" "$BASE/pages/$KEY_B" >/dev/null
curl -sS "${AUTH[@]}" -X PUT -H 'Content-Type: application/json' \
  --data '{"n":"one"}' "$BASE/pages/$KEY_B/state" >/dev/null

# --- publish the board, declaring it may read the source room ---
cat >"$SERVER_RUNDIR/a.html" <<'HTML'
<html><head><title>board</title></head><body>
<span data-live="own">.</span>
<script src="/sync.js"></script>
</body></html>
HTML
PUB=$(curl -sS "${AUTH[@]}" -X PUT --data-binary "@$SERVER_RUNDIR/a.html" \
  -H "X-Read-Rooms: $ROOM_B" "$BASE/pages/$KEY_A")
echo "$PUB" | jq -e --arg r "$ROOM_B" '.readRooms == [$r]' >/dev/null \
  || fail "publish did not record readRooms: $PUB"
echo "$PUB" | jq -e '.warnings | length > 0' >/dev/null \
  || fail "declaring a read must warn that it opens those rooms to this page's viewers: $PUB"
pass "publish records the declared read room and warns about the exposure"

# --- fetch the page as a logged-in human ---
SERVED=$(curl -sS -H "Cookie: lh_sess=$SESS" -H "Sec-Fetch-Mode: navigate" -H "Sec-Fetch-Dest: document" "$BASE/pages/$KEY_A")
COUNT=$(printf '%s' "$SERVED" | grep -o 'sync\.js' | wc -l | tr -d ' ')
[ "$COUNT" = "1" ] || fail "expected exactly one sync.js tag after strip+inject, got $COUNT: $SERVED"
printf '%s' "$SERVED" | grep -q "data-room=\"$ROOM_A\"" || fail "no/wrong data-room in served page: $SERVED"
TOKEN=$(printf '%s' "$SERVED" | grep -o 'data-token="[^"]*"' | head -1 | sed 's/data-token="//;s/"$//')
[ -n "$TOKEN" ] || fail "no data-token in served page: $SERVED"
printf '%s' "$SERVED" | grep -q '<head><script src="/sync.js"' || fail "tag not injected at <head>: $SERVED"
pass "served page carries exactly one tag, injected at <head>, with room + capability"

# --- drive a page session with that capability ---
OUT=$(WS="$WS" TOK="$TOKEN" ROOM_A="$ROOM_A" ROOM_B="$ROOM_B" \
  BASE="$BASE" APITOK="$LIVEHTML_API_TOKEN" bun -e '
  const ws = new WebSocket(process.env.WS);
  const res = { init: false, readInit: null, readUpdate: null, presenceLeak: false };
  let fired = false;
  const done = () => { if (fired) return; fired = true; console.log(JSON.stringify(res)); try { ws.close(); } catch {} setTimeout(() => process.exit(0), 0); };
  ws.addEventListener("open", () => ws.send(JSON.stringify({ t: "hi", room: process.env.ROOM_A, clientId: "board-1", token: process.env.TOK })));
  ws.addEventListener("message", async (e) => {
    const m = JSON.parse(String(e.data));
    if (m.t === "init") {
      res.init = true;
      return;
    }
    if (m.t === "room" && m.room === process.env.ROOM_B) {
      if (m.msg.t === "init") {
        res.readInit = m.msg.state;
        // Change the source room from the outside; the board must see it.
        await fetch(process.env.BASE + "/pages/" + encodeURIComponent(process.env.ROOM_B.slice("pages/".length)) + "/state", {
          method: "PUT",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + process.env.APITOK },
          body: JSON.stringify({ n: "two" }),
        });
        return;
      }
      res.readUpdate = m.msg.state ?? m.msg.v ?? null;
      // Now try to write. `set` only ever touches our own room, so this must
      // land in ROOM_A and leave ROOM_B alone.
      ws.send(JSON.stringify({ t: "set", key: "from-reader", v: "x" }));
      setTimeout(done, 400);
    }
  });
  setTimeout(done, 6000);
')

echo "$OUT" | jq -e '.init == true' >/dev/null || fail "board did not join its own room: $OUT"
echo "$OUT" | jq -e '.readInit.n == "one"' >/dev/null || fail "declared read room did not stream its initial state: $OUT"
echo "$OUT" | jq -e '.readUpdate.n == "two"' >/dev/null || fail "declared read room did not stream the update: $OUT"
pass "the declared room streams in: initial state + live updates"

STATE_B=$(curl -sS "${AUTH[@]}" "$BASE/pages/$KEY_B/state")
echo "$STATE_B" | jq -e 'has("from-reader") | not' >/dev/null \
  || fail "the reader wrote into the room it may only READ: $STATE_B"
STATE_A=$(curl -sS "${AUTH[@]}" "$BASE/pages/$KEY_A/state")
echo "$STATE_A" | jq -e '."from-reader" == "x"' >/dev/null \
  || fail "the reader's write did not land in its own room: $STATE_A"
pass "a reader's writes go to its own room only — the read room is untouched"

echo "OK: publish -> inject -> capability -> read-only cross-room subscription"
