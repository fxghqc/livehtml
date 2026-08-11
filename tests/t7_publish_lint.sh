#!/usr/bin/env bash
# Publish-time lint: patterns that are certain to misbehave in the browser are
# refused at PUT, with the reasons handed back as data so an agent can fix and
# re-publish on its own. Warnings ride along with a successful publish, and
# X-Skip-Lint exists for the day the lint is the one that is wrong.
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
STAMP="t7-$(date +%s)-$$"

publish() { # $1 key  $2 file  [extra curl args...]
  local key=$1 file=$2; shift 2
  curl -sS -w '\n%{http_code}' -X PUT --data-binary "@$file" "$@" "$BASE/pages/$key"
}

# --- a container binding is refused ---
printf '<html><head></head><body><div data-live="poll"><input type="radio"></div></body></html>' \
  >"$SERVER_RUNDIR/bad1.html"
OUT=$(publish "$STAMP/bad1" "$SERVER_RUNDIR/bad1.html")
CODE=$(printf '%s' "$OUT" | tail -n1)
BODY=$(printf '%s' "$OUT" | sed '$d')
assert_eq 400 "$CODE" "a container data-live must be refused"
echo "$BODY" | jq -e '.errors | length == 1' >/dev/null || fail "no error list handed back: $BODY"
echo "$BODY" | jq -e '.errors[0] | contains("容器")' >/dev/null || fail "error is not about the container: $BODY"
pass "container data-live -> 400 with the reason as data"

# and it really did not store anything
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -H "Sec-Fetch-Mode: navigate" -H "Sec-Fetch-Dest: document" "$BASE/pages/$STAMP/bad1")
assert_eq 404 "$CODE" "the refused page must not have been stored"
pass "a refused publish stores nothing"

# --- a hallucinated API member is refused ---
printf '<html><head></head><body><script>LiveHtml.watch("k",function(){})</script></body></html>' \
  >"$SERVER_RUNDIR/bad2.html"
OUT=$(publish "$STAMP/bad2" "$SERVER_RUNDIR/bad2.html")
assert_eq 400 "$(printf '%s' "$OUT" | tail -n1)" "a call to a nonexistent LiveHtml member must be refused"
printf '%s' "$OUT" | sed '$d' | jq -e '.errors[0] | contains("LiveHtml.watch")' >/dev/null \
  || fail "the error does not name the bad member: $OUT"
pass "nonexistent LiveHtml member -> 400 naming the member"

# --- the escape hatch ---
OUT=$(publish "$STAMP/bad1" "$SERVER_RUNDIR/bad1.html" -H "X-Skip-Lint: 1")
assert_eq 200 "$(printf '%s' "$OUT" | tail -n1)" "X-Skip-Lint must publish anyway"
pass "X-Skip-Lint publishes the same page"

# --- a clean page publishes, with its self-supplied tag reported as a warning ---
printf '<html><head></head><body><input data-live="ok"><script src="/sync.js"></script></body></html>' \
  >"$SERVER_RUNDIR/good.html"
OUT=$(publish "$STAMP/good" "$SERVER_RUNDIR/good.html")
assert_eq 200 "$(printf '%s' "$OUT" | tail -n1)" "a clean page must publish"
printf '%s' "$OUT" | sed '$d' | jq -e '.warnings[0] | contains("sync.js")' >/dev/null \
  || fail "the self-supplied sync.js tag should warn: $OUT"
pass "clean page publishes; its own sync.js tag is a warning, not a block"

echo "OK: publish-time lint blocks the certain-to-break patterns and explains itself"
