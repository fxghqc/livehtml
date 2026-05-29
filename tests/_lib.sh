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
# random_port has a TOCTOU window — another process can grab the port between
# our check and bun's listen(). Retry start up to 3 times on EADDRINUSE.
start_server() {
  SERVER_STATE_TMP="$(mktemp -d -t livehtml-test-XXXXXX)/state"
  mkdir -p "$SERVER_STATE_TMP"

  # server.ts hardcodes STATE_DIR = import.meta.dir + "/state", which resolves
  # symlinks back to the source dir. So we *copy* server.ts into the rundir
  # (cheap, ~17KB) and symlink the read-only siblings. import.meta.dir then
  # resolves to the rundir, and state/ is isolated per test.
  SERVER_RUNDIR="$(mktemp -d -t livehtml-test-run-XXXXXX)"
  cp "$REPO_ROOT/server.ts" "$SERVER_RUNDIR/server.ts"
  ln -s "$REPO_ROOT/public" "$SERVER_RUNDIR/public"
  ln -s "$REPO_ROOT/examples" "$SERVER_RUNDIR/examples"
  ln -s "$REPO_ROOT/skill" "$SERVER_RUNDIR/skill"
  ln -s "$REPO_ROOT/auth" "$SERVER_RUNDIR/auth"
  ln -s "$REPO_ROOT/node_modules" "$SERVER_RUNDIR/node_modules"
  ln -s "$REPO_ROOT/package.json" "$SERVER_RUNDIR/package.json"
  ln -s "$REPO_ROOT/tsconfig.json" "$SERVER_RUNDIR/tsconfig.json"
  mkdir -p "$SERVER_RUNDIR/state"

  trap stop_server EXIT INT TERM

  local attempt
  for attempt in 1 2 3; do
    SERVER_PORT=$(random_port) || return 1
    SERVER_LOG="$(mktemp -t livehtml-test-log-XXXXXX)"
    # `exec` replaces the subshell with bun, so $! is the bun PID and a single
    # kill takes the server down (instead of leaking an orphan bun process).
    (cd "$SERVER_RUNDIR" && PORT="$SERVER_PORT" exec bun server.ts) >"$SERVER_LOG" 2>&1 &
    SERVER_PID=$!
    if wait_for_port "$SERVER_PORT" 5; then
      return 0
    fi
    # If bun aborted on EADDRINUSE, try a different port.
    if grep -q "EADDRINUSE" "$SERVER_LOG" 2>/dev/null; then
      kill "$SERVER_PID" 2>/dev/null || true
      wait "$SERVER_PID" 2>/dev/null || true
      continue
    fi
    echo "--- server log ---"
    cat "$SERVER_LOG" || true
    return 1
  done
  echo "start_server failed after 3 EADDRINUSE retries" >&2
  return 1
}

stop_server() {
  if [ -n "${SERVER_PID:-}" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  [ -n "${SERVER_RUNDIR:-}" ] && rm -rf "$SERVER_RUNDIR" 2>/dev/null || true
  [ -n "${SERVER_STATE_TMP:-}" ] && rm -rf "$(dirname "$SERVER_STATE_TMP")" 2>/dev/null || true
}

# Kill the current server and start a fresh one in the SAME rundir, so the
# new instance loads existing state/*.json. Used by V5 (bootId/reset).
restart_server() {
  if [ -z "${SERVER_RUNDIR:-}" ]; then
    echo "restart_server: no SERVER_RUNDIR set (start_server first)" >&2
    return 1
  fi
  if [ -n "${SERVER_PID:-}" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  local attempt
  for attempt in 1 2 3; do
    SERVER_PORT=$(random_port) || return 1
    SERVER_LOG="$(mktemp -t livehtml-test-log-XXXXXX)"
    (cd "$SERVER_RUNDIR" && PORT="$SERVER_PORT" exec bun server.ts) >"$SERVER_LOG" 2>&1 &
    SERVER_PID=$!
    if wait_for_port "$SERVER_PORT" 5; then
      return 0
    fi
    if grep -q "EADDRINUSE" "$SERVER_LOG" 2>/dev/null; then
      kill "$SERVER_PID" 2>/dev/null || true
      wait "$SERVER_PID" 2>/dev/null || true
      continue
    fi
    echo "--- server log (restart) ---"
    cat "$SERVER_LOG" || true
    return 1
  done
  echo "restart_server failed after 3 EADDRINUSE retries" >&2
  return 1
}

# Disarm the EXIT trap so a test can hand-manage the server (e.g. SIGKILL it
# mid-test) without the trap firing again at script exit. The test is then
# responsible for any further cleanup.
disarm_trap() { trap - EXIT INT TERM; }

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

# b64url <stdin> — base64url encode without padding.
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

# mint_session <uid> <name> <secret> — echo a valid lh_sess cookie value.
# Mirrors auth/session.ts: token = b64url(JSON) + "." + b64url(HMAC_SHA256(b64url(JSON))).
mint_session() {
  local json payload sig
  json="{\"uid\":\"$1\",\"name\":\"$2\",\"exp\":9999999999}"
  payload=$(printf '%s' "$json" | b64url)
  sig=$(printf '%s' "$payload" | openssl dgst -sha256 -hmac "$3" -binary | b64url)
  printf '%s.%s' "$payload" "$sig"
}
