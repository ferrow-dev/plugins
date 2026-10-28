#!/bin/sh
# Forwards a hook's stdin to POST $FERROW_URL/agent/hooks/<event> and prints
# the answer. Claude Code and Codex both run this one file; the client is the
# third argument. The token is the one for the workspace the hook's `cwd`
# works in (lib/credentials.sh, ferrow_resolve: the same answer the MCP
# helper gets), or FERROW_AGENT_TOKEN where that may stand in; a repo whose
# workspace has no token sends nothing. Ferrow being down, slow or
# unconfigured prints {} and exits
# 0, so the session never notices. A PostToolUse body goes through
# lib/repo-map.mjs first when Node and that file are here: it adds the targets
# the repo's ferrow.toml gives the touched files, and leaves the body as it
# was when there is no ferrow.toml or anything fails. Under the daemon
# (FERROW_DAEMON set) SessionEnd is skipped: the daemon ends the session
# itself, with its usage.
event="$1"
max_time="${2:-5}"
client="${3:-claude_code}"
quiet() { printf '{}\n'; exit 0; }
[ -n "$event" ] || quiet
[ "$event" = SessionEnd ] && [ -n "$FERROW_DAEMON" ] && quiet
base="${FERROW_URL:-https://app.ferrow.dev}"
base="${base%/}"
body="$(mktemp "${TMPDIR:-/tmp}/ferrow-hook.XXXXXX")" || quiet
trap 'rm -f "$body" "$body.map"' EXIT
cat >"$body"
token="$FERROW_AGENT_TOKEN"
# A Routine copies this file alone (clients/routines), without lib/, and
# runs on FERROW_AGENT_TOKEN.
credentials="$(dirname "$0")/../lib/credentials.sh"
if [ -r "$credentials" ]; then
  . "$credentials"
  base="$(ferrow_server)"
  dir="$(sed -nE 's/.*"cwd"[[:space:]]*:[[:space:]]*"(([^"\\]|\\.)*)".*/\1/p' "$body" | head -n 1)"
  [ -d "$dir" ] || dir="$(pwd)"
  ferrow_resolve "$dir"
  token="$ferrow_token"
  [ -n "$token" ] || [ -z "$ferrow_envok" ] || token="$FERROW_AGENT_TOKEN"
fi
[ -n "$token" ] || quiet
command -v curl >/dev/null 2>&1 || quiet
lib="$(dirname "$0")/../lib/repo-map.mjs"
if [ "$event" = PostToolUse ] && [ -f "$lib" ] && command -v node >/dev/null 2>&1; then
  node "$lib" <"$body" >"$body.map" 2>/dev/null && [ -s "$body.map" ] && mv "$body.map" "$body"
fi
answer="$(printf 'header = "Authorization: Bearer %s"\n' "$token" |
  curl --silent --fail --max-time "$max_time" --config - \
    --header 'Content-Type: application/json' \
    --header "X-Ferrow-Client: $client" \
    --data-binary "@$body" \
    "$base/agent/hooks/$event" 2>/dev/null)" || answer=""
[ -n "$answer" ] || quiet
printf '%s\n' "$answer"
exit 0
