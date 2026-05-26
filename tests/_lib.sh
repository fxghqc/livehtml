#!/usr/bin/env bash
# Shared test helpers. Source this from each V script.
# No external deps beyond curl + bash + (optional) jq.
#
# Usage:
#   source "$(dirname "$0")/_lib.sh"
#   start_server          # populates $SERVER_PORT and $SERVER_PID, sets trap
#   curl http://127.0.0.1:$SERVER_PORT/...
#   pass "message"        # or fail "message"
#
# Each helper exits with a clear message on misuse.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Pick a free ephemeral port. Retries a few times to avoid TOCTOU.
random_port() {
  local p
  for _ in 1 2 3 4 5; do
    p=$(( (RANDOM % 16000) + 49152 ))
    if ! lsof -i :"$p" -sTCP:LISTEN -t >/dev/null 2>&1; then
      echo "$p"
      return 0
    fi
  done
  echo "could not find free port" >&2
  return 1
}

wait_for_port() {
  local port=$1 timeout_s=${2:-5} elapsed=0
  while [ "$elapsed" -lt "$((timeout_s * 10))" ]; do
    if curl -sf -o /dev/null "http://127.0.0.1:$port/" 2>/dev/null; then
      return 0
    fi
    sleep 0.1
    elapsed=$((elapsed + 1))
  done
  echo "server on port $port did not respond within ${timeout_s}s" >&2
  return 1
}

# Spawn `bun server.ts` on a random port. Each test gets its own STATE_DIR_TEST
# under /tmp so tests don't pollute the dev state/.
start_server() {
  SERVER_PORT=$(random_port) || return 1
  SERVER_STATE_TMP="$(mktemp -d -t livehtml-test-XXXXXX)/state"
  mkdir -p "$SERVER_STATE_TMP"
  SERVER_LOG="$(mktemp -t livehtml-test-log-XXXXXX)"

  # We point STATE_DIR at a tmp dir by symlinking ROOT/state -> tmp.
  # But server.ts hardcodes STATE_DIR = ROOT/state. To isolate, run in a clean
  # subdir that symlinks back to the real source files but has its own state/.
  SERVER_RUNDIR="$(mktemp -d -t livehtml-test-run-XXXXXX)"
  ln -s "$REPO_ROOT/server.ts" "$SERVER_RUNDIR/server.ts"
  ln -s "$REPO_ROOT/public" "$SERVER_RUNDIR/public"
  ln -s "$REPO_ROOT/examples" "$SERVER_RUNDIR/examples"
  ln -s "$REPO_ROOT/skill" "$SERVER_RUNDIR/skill"
  ln -s "$REPO_ROOT/node_modules" "$SERVER_RUNDIR/node_modules"
  ln -s "$REPO_ROOT/package.json" "$SERVER_RUNDIR/package.json"
  ln -s "$REPO_ROOT/tsconfig.json" "$SERVER_RUNDIR/tsconfig.json"
  mkdir -p "$SERVER_RUNDIR/state"

  (cd "$SERVER_RUNDIR" && PORT="$SERVER_PORT" bun server.ts >"$SERVER_LOG" 2>&1) &
  SERVER_PID=$!
  trap stop_server EXIT INT TERM
  if ! wait_for_port "$SERVER_PORT" 5; then
    echo "--- server log ---"
    cat "$SERVER_LOG" || true
    return 1
  fi
}

stop_server() {
  if [ -n "${SERVER_PID:-}" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  [ -n "${SERVER_RUNDIR:-}" ] && rm -rf "$SERVER_RUNDIR" 2>/dev/null || true
  [ -n "${SERVER_STATE_TMP:-}" ] && rm -rf "$(dirname "$SERVER_STATE_TMP")" 2>/dev/null || true
}

# Pretty output.
pass() { echo "PASS: $*"; }
fail() {
  echo "FAIL: $*" >&2
  if [ -n "${SERVER_LOG:-}" ] && [ -f "$SERVER_LOG" ]; then
    echo "--- server log ---" >&2
    tail -40 "$SERVER_LOG" >&2
  fi
  exit 1
}

# assert_eq <expected> <actual> <label>
assert_eq() {
  if [ "$1" != "$2" ]; then
    echo "expected: $1" >&2
    echo "actual:   $2" >&2
    fail "$3"
  fi
}

# Curl JSON helper. Sets HTTP_CODE and BODY.
http() {
  local method=$1 url=$2 body=${3:-}
  if [ -n "$body" ]; then
    BODY=$(curl -sS -w "\n%{http_code}" -X "$method" -H "Content-Type: application/json" --data "$body" "$url")
  else
    BODY=$(curl -sS -w "\n%{http_code}" -X "$method" "$url")
  fi
  HTTP_CODE=$(printf '%s' "$BODY" | tail -n1)
  BODY=$(printf '%s' "$BODY" | sed '$d')
}
