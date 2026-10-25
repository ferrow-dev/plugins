# The credentials file (wiki `14 · Agent layer` §17.4), sourced by
# bin/ferrow-headers, bin/ferrow-login and hooks/ferrow-hook.sh. POSIX sh, no
# jq: the file is JSON, but only bin/ferrow-login writes it, one server per
# line, so a line is an entry:
#
#   {"version": 1, "servers": {
#     "https://app.ferrow.dev": {"token": "frw_pat_…", "workspace": "acme", …}
#   }}
#
# Every reader checks this file first and FERROW_AGENT_TOKEN after it.

ferrow_credentials() {
  printf '%s/ferrow/credentials.json\n' "${XDG_CONFIG_HOME:-$HOME/.config}"
}

# The key a server is filed under: its URL without a trailing `/` or `/mcp`.
ferrow_server() {
  _fsrv="${1:-${FERROW_URL:-https://app.ferrow.dev}}"
  _fsrv="${_fsrv%/}"
  _fsrv="${_fsrv%/mcp}"
  printf '%s\n' "${_fsrv%/}"
}

# The entry's line for a server, as stored; nothing when there is none.
ferrow_entry() {
  _ffile="$(ferrow_credentials)"
  [ -r "$_ffile" ] || return 0
  awk -v key="  \"$1\": {" 'index($0, key) == 1 { print; exit }' "$_ffile"
}

# One string field of a JSON line, still escaped as JSON.
ferrow_field() {
  printf '%s\n' "$1" | sed -nE "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"(([^\"\\\\]|\\\\.)*)\".*/\\1/p" | head -n 1
}

ferrow_file_token() {
  ferrow_field "$(ferrow_entry "$1")" token
}

# Rewrites the file with the server's entry replaced by $2 (one JSON object
# on one line), or dropped when $2 is empty. Atomic: a temporary file in the
# same directory, then mv; the directory 0700, the file 0600.
ferrow_write_entry() {
  _ffile="$(ferrow_credentials)"
  _fdir="$(dirname "$_ffile")"
  (
    umask 077
    mkdir -p "$_fdir" && chmod 700 "$_fdir" || exit 1
    _fnext="$(mktemp "$_fdir/.credentials.XXXXXX")" || exit 1
    trap 'rm -f "$_fnext"' EXIT
    {
      [ -r "$_ffile" ] && awk -v key="  \"$1\": {" 'index($0, "  \"") == 1 && index($0, key) != 1 { sub(/,$/, ""); print }' "$_ffile"
      [ -n "$2" ] && printf '  "%s": %s\n' "$1" "$2"
    } | awk 'BEGIN { print "{\"version\": 1, \"servers\": {" }
             { if (NR > 1) print last ","; last = $0 }
             END { if (NR > 0) print last; print "}}" }' >"$_fnext" || exit 1
    chmod 600 "$_fnext" && mv "$_fnext" "$_ffile" && trap - EXIT
  )
}
