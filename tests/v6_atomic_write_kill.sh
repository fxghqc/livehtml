#!/usr/bin/env bash
# B.V6 — SIGKILL the server mid-write storm; every state/*.json that exists
# afterwards must parse as valid JSON (no half-written / truncated files).
#
# Implementation: per-room write chain + tmp file → rename is already in
# server.ts (doSave at lines ~94-105). This test verifies that behavior end
# to end: in-flight writes either complete the rename or leave only the
# final-good file (.tmp files allowed; they'd be cleaned up on next save
# or on manual cleanup).

set -uo pipefail
source "$(dirname "$0")/_lib.sh"

start_server
BASE="http://127.0.0.1:$SERVER_PORT"
N=50

# Spawn N parallel PUTs each to its own key with a sizable JSON body.
# Using distinct keys exercises many rooms in parallel; the per-room write
# chain still applies (one chain per room).
PAYLOAD=$(printf '{"a":"%s","b":%d}' "$(printf 'x%.0s' $(seq 1 500))" 12345)
for i in $(seq 1 $N); do
  curl -sS -m 5 -X PUT -H "Content-Type: application/json" \
    --data "$PAYLOAD" \
    "$BASE/pages/atomic-$$-$i/state" >/dev/null &
done

# Give the requests time to land in the write chain, then SIGKILL.
sleep 0.3
kill -9 "$SERVER_PID" 2>/dev/null || true
wait 2>/dev/null || true

# Disarm trap so we can inspect the rundir before it's torn down.
trap - EXIT INT TERM

# Walk every json file in state/.
STATE_DIR_REAL="$SERVER_RUNDIR/state"
BAD=0
TOTAL=0
TMPCOUNT=0
for f in "$STATE_DIR_REAL"/*.json "$STATE_DIR_REAL"/*.json.tmp; do
  [ -e "$f" ] || continue
  case "$f" in
    *.tmp)
      TMPCOUNT=$((TMPCOUNT + 1))
      # .tmp files MAY be partial — that's the whole point of the rename.
      # They're acceptable as long as no .json file is corrupt.
      ;;
    *.json)
      TOTAL=$((TOTAL + 1))
      if ! jq empty "$f" >/dev/null 2>&1; then
        echo "CORRUPT: $f" >&2
        head -c 200 "$f" >&2; echo >&2
        BAD=$((BAD + 1))
      fi
      ;;
  esac
done

echo "scanned: $TOTAL .json files (+$TMPCOUNT .tmp residuals)"
[ "$BAD" = "0" ] || fail "$BAD corrupt .json files after SIGKILL"

# Manual cleanup since trap was disarmed.
rm -rf "$SERVER_RUNDIR" 2>/dev/null || true

pass "all $TOTAL .json state files parse as valid JSON after SIGKILL"
echo "OK: atomic-write guarantees survived SIGKILL during $N parallel PUTs"
