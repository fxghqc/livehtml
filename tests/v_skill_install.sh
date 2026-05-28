#!/usr/bin/env bash
# Skill install flow:
#   - /skill/SKILL.md is served RAW (uses the $LIVEHTML_BASE_URL shell var;
#     the server does NOT rewrite it — the URL lives in a config file instead)
#   - /install emits a script that writes the base URL to
#     $XDG_STATE_HOME/livehtml/base-url (default ~/.local/state/livehtml/base-url)
#     and fetches SKILL.md
#   - running that script in a sandbox HOME produces both files
#   - path traversal + unknown file still 404
#
# Pass: all assertions below.

set -uo pipefail
source "$(dirname "$0")/_lib.sh"

start_server
BASE="http://127.0.0.1:$SERVER_PORT"

# 1) SKILL.md served raw, still contains the shell-var placeholder.
http GET "$BASE/skill/SKILL.md"
assert_eq 200 "$HTTP_CODE" "/skill/SKILL.md status"
if ! printf '%s' "$BODY" | grep -q '\$LIVEHTML_BASE_URL'; then
  fail "served SKILL.md should keep the \$LIVEHTML_BASE_URL shell var (no server rewrite)"
fi
if ! printf '%s' "$BODY" | grep -qF 'base-url'; then
  fail "served SKILL.md should mention the base-url config file"
fi
pass "SKILL.md served raw with \$LIVEHTML_BASE_URL + base-url setup"

# 2) /install script writes config + fetches SKILL.md.
http GET "$BASE/install"
assert_eq 200 "$HTTP_CODE" "/install status"
if ! printf '%s' "$BODY" | grep -qF 'base-url'; then
  fail "/install script should write base-url"
fi
if ! printf '%s' "$BODY" | grep -qF "$BASE"; then
  fail "/install script should embed the server base $BASE"
fi
if ! printf '%s' "$BODY" | grep -qF 'XDG_STATE_HOME'; then
  fail "/install should honor XDG_STATE_HOME"
fi
pass "/install script writes base-url, embeds base, honors XDG_STATE_HOME"

# 3) End-to-end: run the installer in a sandbox HOME.
TMPHOME="$(mktemp -d -t livehtml-install-XXXXXX)"
INSTALL_SH="$(mktemp -t livehtml-install-sh-XXXXXX)"
curl -sS "$BASE/install" -o "$INSTALL_SH"
( unset XDG_STATE_HOME; HOME="$TMPHOME" sh "$INSTALL_SH" ) >/dev/null 2>&1 \
  || fail "installer script exited non-zero"

SKILL_OUT="$TMPHOME/.claude/skills/livehtml/SKILL.md"
URL_OUT="$TMPHOME/.local/state/livehtml/base-url"
[ -f "$SKILL_OUT" ] || fail "installer did not write $SKILL_OUT"
[ -f "$URL_OUT" ] || fail "installer did not write $URL_OUT"
SAVED=$(cat "$URL_OUT")
assert_eq "$BASE" "$SAVED" "saved base-url content"
pass "end-to-end install wrote SKILL.md + base-url=$SAVED"

rm -rf "$TMPHOME" "$INSTALL_SH"

# 4) Path traversal + unknown file guards.
http GET "$BASE/skill/..%2F..%2Fserver.ts"
[ "$HTTP_CODE" = "404" ] || fail "path traversal should 404, got $HTTP_CODE"
http GET "$BASE/skill/no-such-file.md"
[ "$HTTP_CODE" = "404" ] || fail "unknown skill file should 404, got $HTTP_CODE"
pass "path traversal + unknown file both 404"

echo "OK: skill install writes config; SKILL.md served raw"
