#!/usr/bin/env bash
# Cookie-granted surfaces are for people, not for script. Published pages run on
# this origin, so a fetch() from inside one carries the viewer's session — these
# two gates are what stop that fetch from minting the viewer an API token or
# reading another protected page's HTML.
#
# Sec-Fetch-* are browser-set forbidden headers: page JS can neither add nor
# remove them. curl can send anything, which is exactly how both sides are
# exercised below.

set -uo pipefail
source "$(dirname "$0")/_lib.sh"

export DINGTALK_CLIENT_ID="testkey"
export DINGTALK_CLIENT_SECRET="testsecret"
export SESSION_SECRET="unit-secret"
export LIVEHTML_API_TOKEN="test-api-token"

MINIO_AT="${LIVEHTML_TEST_MINIO:-127.0.0.1:9000}"
WITH_MINIO=0
if curl -sf -o /dev/null "http://$MINIO_AT/minio/health/live"; then
  WITH_MINIO=1
  export MINIO_ENDPOINT="$MINIO_AT"
  export MINIO_ACCESS_KEY="${LIVEHTML_TEST_MINIO_KEY:-k2data}"
  export MINIO_SECRET_KEY="${LIVEHTML_TEST_MINIO_SECRET:-K2data1234}"
  export MINIO_BUCKET="livehtml-test-$$"
fi

cleanup_bucket() {
  [ "$WITH_MINIO" = "1" ] || return 0
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
SESS=$(mint_session "u7" "Seven" "$SESSION_SECRET")

# What a fetch() from a published page looks like on the wire, vs what a person
# clicking a link looks like.
FETCH_HDRS=(-H "Sec-Fetch-Site: same-origin" -H "Sec-Fetch-Mode: cors" -H "Sec-Fetch-Dest: empty")
NAV_HDRS=(-H "Sec-Fetch-Site: same-origin" -H "Sec-Fetch-Mode: navigate" -H "Sec-Fetch-Dest: document")
FRAME_HDRS=(-H "Sec-Fetch-Site: same-origin" -H "Sec-Fetch-Mode: navigate" -H "Sec-Fetch-Dest: iframe")

# --- gate 1: /auth/token cannot be minted by script ---
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -H "Cookie: lh_sess=$SESS" "${FETCH_HDRS[@]}" \
  "$BASE/auth/token?format=json")
[ "$CODE" = "403" ] || fail "a page-JS fetch minted a token (HTTP $CODE) — it can steal the viewer's 30-day bearer"
pass "gate 1: script-initiated /auth/token -> 403"

BODY=$(curl -sS -H "Cookie: lh_sess=$SESS" "${NAV_HDRS[@]}" "$BASE/auth/token?format=json")
echo "$BODY" | jq -e '.token | length > 0' >/dev/null \
  || fail "a real navigation must still mint (the CLI login flow): $BODY"
pass "gate 1: browser navigation still mints (CLI login unaffected)"

# The refresh path is bearer-authenticated, not cookie-authenticated, so it is
# untouched by the navigation rule — check it did not become collateral damage.
APITOK=$(mint_api_token "u7" "Seven" "$SESSION_SECRET")
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $APITOK" \
  "${FETCH_HDRS[@]}" "$BASE/auth/token/refresh")
[ "$CODE" = "200" ] || fail "/auth/token/refresh broke for bearer holders (HTTP $CODE)"
pass "gate 1: /auth/token/refresh still works for a bearer holder"

# --- gate 2: a protected page's HTML is served to navigations only ---
if [ "$WITH_MINIO" = "0" ]; then
  echo "SKIP (gate 2): no MinIO at $MINIO_AT — /pages needs storage"
  echo "OK: gate 1 verified; gate 2 skipped"
  exit 0
fi

KEY="t5-$(date +%s)-$$"
printf '<html><head></head><body>secret</body></html>' >"$SERVER_RUNDIR/p.html"
curl -sS -H "Authorization: Bearer $LIVEHTML_API_TOKEN" -X PUT \
  --data-binary "@$SERVER_RUNDIR/p.html" "$BASE/pages/$KEY" >/dev/null
curl -sS -H "Authorization: Bearer $LIVEHTML_API_TOKEN" -X PUT \
  --data-binary "@$SERVER_RUNDIR/p.html" -H "X-Public: 1" "$BASE/pages/$KEY-pub" >/dev/null

CODE=$(curl -sS -o /dev/null -w '%{http_code}' -H "Cookie: lh_sess=$SESS" "${FETCH_HDRS[@]}" "$BASE/pages/$KEY")
[ "$CODE" = "401" ] || fail "page JS read a protected page's HTML with the viewer's cookie (HTTP $CODE)"
pass "gate 2: script-initiated GET of a protected page -> 401"

CODE=$(curl -sS -o /dev/null -w '%{http_code}' -H "Cookie: lh_sess=$SESS" "${NAV_HDRS[@]}" "$BASE/pages/$KEY")
[ "$CODE" = "200" ] || fail "a person opening the page must still get it (HTTP $CODE)"
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -H "Cookie: lh_sess=$SESS" "${FRAME_HDRS[@]}" "$BASE/pages/$KEY")
[ "$CODE" = "200" ] || fail "iframe embedding must keep working (HTTP $CODE)"
pass "gate 2: navigation and iframe embedding both still serve the page"

CODE=$(curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $LIVEHTML_API_TOKEN" \
  "${FETCH_HDRS[@]}" "$BASE/pages/$KEY")
[ "$CODE" = "200" ] || fail "a bearer holder must be able to fetch page HTML programmatically (HTTP $CODE)"
pass "gate 2: bearer callers are unaffected"

CODE=$(curl -sS -o /dev/null -w '%{http_code}' "${FETCH_HDRS[@]}" "$BASE/pages/$KEY-pub")
[ "$CODE" = "200" ] || fail "public pages must stay fetchable — nothing there is cookie-gated (HTTP $CODE)"
pass "gate 2: public pages stay fetchable"

echo "OK: cookie-granted surfaces require a navigation; bearer and public paths unchanged"
