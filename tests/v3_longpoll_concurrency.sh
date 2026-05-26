#!/usr/bin/env bash
# B.V3 — 100 concurrent long-polls; server RSS stays bounded and the waiter
# table empties after all polls drain (cleanup test).
#
# Pass:
#   - peak RSS grew < 50 MB while polls were parked
#   - after all polls drained, RSS came back within 25 MB of baseline
#     (leak indicator; not a strict equality because GC is lazy)
#
# Uses macOS-compatible `ps -o rss=` (KB).

set -uo pipefail
source "$(dirname "$0")/_lib.sh"

start_server
BASE="http://127.0.0.1:$SERVER_PORT"
KEY="b-v3-$(date +%s)-$$"

# Bootstrap.
RESP=$(curl -sS "$BASE/pages/$KEY/state?wait=1")
ETAG=$(printf '%s' "$RESP" | jq -r .etag)

# Baseline RSS (KB).
RSS_BEFORE=$(ps -o rss= -p "$SERVER_PID" | tr -d ' ')
[ -n "$RSS_BEFORE" ] || fail "could not read baseline RSS"

# Fire 100 concurrent polls with wait=5. Track PIDs so we wait only on
# the curls, not on the bun server (also a bg job under this shell).
CURL_PIDS=()
for _ in $(seq 1 100); do
  curl -sS -m 10 "$BASE/pages/$KEY/state?wait=5&since=$ETAG" >/dev/null &
  CURL_PIDS+=($!)
done

# Let them all register, then sample peak RSS.
sleep 2
RSS_PEAK=$(ps -o rss= -p "$SERVER_PID" | tr -d ' ')

# Wait only for the curls (server is also bg under this shell).
for p in "${CURL_PIDS[@]}"; do wait "$p" 2>/dev/null || true; done

# Give the server a moment to remove waiters from its Map.
sleep 1
RSS_AFTER=$(ps -o rss= -p "$SERVER_PID" | tr -d ' ')

DELTA_PEAK=$((RSS_PEAK - RSS_BEFORE))
DELTA_AFTER=$((RSS_AFTER - RSS_BEFORE))

echo "RSS baseline=${RSS_BEFORE}KB peak=${RSS_PEAK}KB after=${RSS_AFTER}KB  Δpeak=${DELTA_PEAK}KB Δafter=${DELTA_AFTER}KB"

# 50 MB = 51200 KB; 25 MB = 25600 KB.
[ "$DELTA_PEAK" -lt 51200 ] || fail "peak RSS grew ${DELTA_PEAK}KB during 100 polls (want <50MB)"
[ "$DELTA_AFTER" -lt 25600 ] || fail "RSS leaked ${DELTA_AFTER}KB after polls drained (want <25MB)"

# Sanity: server still alive.
if ! curl -sf -o /dev/null "$BASE/"; then
  fail "server unresponsive after concurrency test"
fi

pass "100 concurrent long-polls drained cleanly"
echo "OK: waiter cleanup keeps RSS bounded"
