#!/usr/bin/env bash
# C.V1 — after writes, the on-disk state file is the new envelope:
#   { "version": 2, "fields": { key: { v, ts, by } } }
# with ts a valid ISO timestamp and by set per write source.

set -uo pipefail
source "$(dirname "$0")/_lib.sh"

start_server
BASE="http://127.0.0.1:$SERVER_PORT"
KEY="c-v1-$(date +%s)-$$"

# Write via HTTP PUT.
http PUT "$BASE/pages/$KEY/state" '{"a":1,"b":"hello","c":true}'
assert_eq 200 "$HTTP_CODE" "PUT failed: $BODY"

# scheduleSave debounces 300ms.
sleep 0.6

FILE="$SERVER_RUNDIR/state/pages__$KEY.json"
[ -f "$FILE" ] || fail "state file $FILE missing"

# Top-level shape.
VERSION=$(jq -r .version "$FILE")
[ "$VERSION" = "2" ] || fail "expected .version=2 on disk, got $VERSION (raw=$(cat "$FILE"))"
HAS_FIELDS=$(jq -r 'has("fields")' "$FILE")
[ "$HAS_FIELDS" = "true" ] || fail "expected .fields object on disk"
pass "disk shape: version=2 with .fields"

# Per-key entries.
for k in a b c; do
  V=$(jq -r ".fields.\"$k\".v" "$FILE")
  TS=$(jq -r ".fields.\"$k\".ts" "$FILE")
  BY=$(jq -r ".fields.\"$k\".by" "$FILE")
  [ "$V" != "null" ] || fail "fields.$k.v is null"
  [ "$BY" = "http" ] || fail "fields.$k.by expected http, got $BY"
  # ISO timestamp: must contain T and end with Z (or +offset)
  printf '%s' "$TS" | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}' \
    || fail "fields.$k.ts not ISO: $TS"
done
pass "all three keys have v / valid ISO ts / by=http"

# Sanity: values round-trip via flat GET (default).
http GET "$BASE/pages/$KEY/state"
assert_eq 200 "$HTTP_CODE" "GET failed"
FLAT_A=$(printf '%s' "$BODY" | jq -r .a)
FLAT_B=$(printf '%s' "$BODY" | jq -r .b)
FLAT_C=$(printf '%s' "$BODY" | jq -r .c)
[ "$FLAT_A" = "1" ] && [ "$FLAT_B" = "hello" ] && [ "$FLAT_C" = "true" ] \
  || fail "round-trip flat GET wrong: a=$FLAT_A b=$FLAT_B c=$FLAT_C"
pass "default GET round-trips values flat (no envelope leak)"

echo "OK: on-disk envelope shape is {version:2, fields:{...}}"
