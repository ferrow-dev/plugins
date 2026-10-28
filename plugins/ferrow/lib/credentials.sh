# The credentials file and the workspace a repo works in (wiki `14 · Agent
# layer` §17.4), sourced by bin/ferrow-headers (MCP), hooks/ferrow-hook.sh
# (hooks), bin/ferrow-workspace (the mod) and bin/ferrow-login. All three
# readers resolve through ferrow_resolve below, so one session never runs
# MCP on one agent and its hooks on another.
#
# POSIX sh, no jq: the files are JSON, but only this file writes them, one
# entry per line, so a line is an entry. An agent belongs to one workspace,
# so the credentials are keyed by workspace:
#
#   {"version": 2, "workspaces": {
#     "acme": {"token": "frw_pat_…", "agent_id": "…", "agent_name": "…", …}
#   }}
#
# Ferrow is one service. FERROW_URL is for development only: a server other
# than the default keeps its tokens in credentials.<host>.json (and its
# bindings in repos.<host>.json), so a dev token never mixes with a
# production one.
#
# repos.json binds a repo root to a workspace, for repos whose ferrow.toml
# does not name one:
#
#   {"version": 1, "repos": {
#     "/home/me/acme-web": "acme"
#   }}

FERROW_DEFAULT_URL="https://app.ferrow.dev"

ferrow_dir() {
  printf '%s/ferrow\n' "${XDG_CONFIG_HOME:-$HOME/.config}"
}

# The server: FERROW_URL (or $1) without a trailing `/`, or the MCP path
# (`/mcp/agent`, `/mcp/user`, `/mcp`).
ferrow_server() {
  _fsrv="${1:-${FERROW_URL:-$FERROW_DEFAULT_URL}}"
  _fsrv="${_fsrv%/}"
  _fsrv="${_fsrv%/agent}"
  _fsrv="${_fsrv%/user}"
  _fsrv="${_fsrv%/mcp}"
  printf '%s\n' "${_fsrv%/}"
}

# A file for the server: `<name>.json` for Ferrow itself, `<name>.<host>.json`
# for a development server.
ferrow_file() {
  _fsrv="$(ferrow_server "$2")"
  if [ "$_fsrv" = "$FERROW_DEFAULT_URL" ]; then
    printf '%s/%s.json\n' "$(ferrow_dir)" "$1"
  else
    _fhost="${_fsrv#*://}"
    _fhost="${_fhost%%/*}"
    printf '%s/%s.%s.json\n' "$(ferrow_dir)" "$1" "$(printf '%s' "$_fhost" | tr -c 'A-Za-z0-9.-' '_')"
  fi
}

ferrow_credentials() {
  ferrow_file credentials "$1"
}

ferrow_repos() {
  ferrow_file repos "$1"
}

# A string as it goes between JSON quotes.
ferrow_json() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

# The line of `file` filed under `key` (a JSON-escaped string); nothing when
# there is none.
ferrow_line() {
  [ -r "$1" ] || return 0
  awk -v key="  \"$2\": " 'index($0, key) == 1 { print; exit }' "$1"
}

# One string field of a JSON line, still escaped as JSON.
ferrow_field() {
  printf '%s\n' "$1" | sed -nE "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"(([^\"\\\\]|\\\\.)*)\".*/\\1/p" | head -n 1
}

# The keys of a file's entries, one per line, still escaped.
ferrow_keys() {
  [ -r "$1" ] || return 0
  sed -nE 's/^  "(([^"\\]|\\.)*)": .*/\1/p' "$1"
}

# Rewrites `file` (a `{"version": V, "<outer>": {…}}` document) with the
# entry under `key` replaced by `value` (JSON on one line), or dropped when
# `value` is empty. Atomic: a temporary file in the same directory, then mv;
# the directory 0700, the file 0600.
ferrow_write_line() {
  _ffile="$1" _fouter="$2" _fversion="$3" _fkey="$4" _fvalue="$5"
  _fdir="$(dirname "$_ffile")"
  (
    umask 077
    mkdir -p "$_fdir" && chmod 700 "$_fdir" || exit 1
    _fnext="$(mktemp "$_fdir/.ferrow.XXXXXX")" || exit 1
    trap 'rm -f "$_fnext"' EXIT
    {
      [ -r "$_ffile" ] && awk -v key="  \"$_fkey\": " 'index($0, "  \"") == 1 && index($0, key) != 1 { sub(/,$/, ""); print }' "$_ffile"
      [ -n "$_fvalue" ] && printf '  "%s": %s\n' "$_fkey" "$_fvalue"
    } | awk -v head="{\"version\": $_fversion, \"$_fouter\": {" 'BEGIN { print head }
             { if (NR > 1) print last ","; last = $0 }
             END { if (NR > 0) print last; print "}}" }' >"$_fnext" || exit 1
    chmod 600 "$_fnext" && mv "$_fnext" "$_ffile" && trap - EXIT
  )
}

# A version-1 file (one entry per server, each naming its workspace) becomes
# version 2: each entry is filed under its workspace, in the file for its
# server. Run by every reader; a second run finds version 2 and does nothing.
ferrow_migrate() {
  _fold="$(ferrow_dir)/credentials.json"
  [ -r "$_fold" ] || return 0
  head -n 1 "$_fold" | grep -q '"version": 1' || return 0
  # Ferrow's own entries are gathered in a new file that replaces the old
  # one in a single mv, so a reader running meanwhile sees one or the other.
  _fnew="$(ferrow_dir)/.credentials.v2.$$.json"
  rm -f "$_fnew"
  ferrow_keys "$_fold" | while IFS= read -r _fsrvkey; do
    _fentry="$(ferrow_line "$_fold" "$_fsrvkey")"
    _fws="$(ferrow_field "$_fentry" workspace)"
    [ -n "$_fws" ] || continue
    _fvalue="$(printf '%s\n' "$_fentry" | sed -E -e 's/^  "([^"\\]|\\.)*": //' -e 's/,$//' -e 's/"workspace": "([^"\\]|\\.)*", //')"
    _fto="$(ferrow_credentials "$_fsrvkey")"
    [ "$_fto" = "$_fold" ] && _fto="$_fnew"
    ferrow_write_line "$_fto" workspaces 2 "$_fws" "$_fvalue"
  done
  if [ -f "$_fnew" ]; then
    mv "$_fnew" "$_fold"
  else
    rm -f "$_fold"
  fi
}

# The entry filed under a workspace in this server's file.
ferrow_entry() {
  ferrow_line "$(ferrow_credentials)" "$(ferrow_json "$1")"
}

ferrow_file_token() {
  ferrow_field "$(ferrow_entry "$1")" token
}

ferrow_write_entry() {
  ferrow_write_line "$(ferrow_credentials)" workspaces 2 "$(ferrow_json "$1")" "$2"
}

# The workspaces this server's file holds a token for, one per line.
ferrow_workspaces() {
  ferrow_keys "$(ferrow_credentials)"
}

# The repo a directory is in: git's top level, or the directory itself.
ferrow_repo_root() {
  git -C "$1" rev-parse --show-toplevel 2>/dev/null || (cd "$1" 2>/dev/null && pwd -P) || printf '%s\n' "$1"
}

# The directory the Claude Code session runs in, for bin/ferrow-headers.
# Claude Code runs a plugin server's headersHelper in the plugin's own
# directory and passes the session's in no variable, so it is the cwd of the
# `claude` process above. The walk goes up only through processes standing in
# the helper's directory (the helper, the `sh` Claude Code starts it with):
# the first that stands elsewhere is either `claude` or not a session, and
# then the helper's own directory is the answer.
ferrow_session_dir() {
  _fhere="$(pwd -P)"
  _fpid="$PPID" _fsteps=0
  while [ "$_fsteps" -lt 4 ] && [ "${_fpid:-0}" -gt 1 ]; do
    if [ -r "/proc/$_fpid/stat" ]; then
      _fcomm="$(cat "/proc/$_fpid/comm" 2>/dev/null)"
      _fcwd="$(readlink "/proc/$_fpid/cwd" 2>/dev/null)"
      _fnext="$(sed 's/.*) //' "/proc/$_fpid/stat" 2>/dev/null | cut -d ' ' -f 2)"
    else
      _fps="$(ps -o ppid= -o comm= -p "$_fpid" 2>/dev/null)" || break
      _fnext="$(printf '%s\n' "$_fps" | awk '{ print $1 }')"
      _fcomm="$(basename "$(printf '%s\n' "$_fps" | sed -E 's/^ *[0-9]+ +//')")"
      _fcwd="$(lsof -a -p "$_fpid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')"
    fi
    [ -n "$_fcwd" ] || break
    case "$_fcomm" in
      claude | claude-* | claude.*)
        printf '%s\n' "$_fcwd"
        return 0
        ;;
    esac
    [ "$_fcwd" = "$_fhere" ] || break
    _fpid="$_fnext" _fsteps=$((_fsteps + 1))
  done
  printf '%s\n' "$_fhere"
}

# The nearest ferrow.toml at or above a directory, up to its repo's root.
ferrow_map_file() {
  _fat="$(cd "$1" 2>/dev/null && pwd -P)" || return 0
  while [ -n "$_fat" ]; do
    if [ -f "$_fat/ferrow.toml" ]; then
      printf '%s/ferrow.toml\n' "$_fat"
      return 0
    fi
    [ -e "$_fat/.git" ] && return 0
    [ "$_fat" = / ] && return 0
    _fat="$(dirname "$_fat")"
  done
}

# `workspace = "<slug>"` from the top of a ferrow.toml, before any table.
ferrow_map_workspace() {
  [ -r "$1" ] || return 0
  awk '/^[[:space:]]*\[/ { exit }
       match($0, /^[[:space:]]*workspace[[:space:]]*=[[:space:]]*"[^"]*"/) {
         line = substr($0, RSTART, RLENGTH); sub(/^[^"]*"/, "", line); sub(/"$/, "", line); print line; exit
       }' "$1"
}

# The workspace repos.json binds a repo root to, if any.
ferrow_bound() {
  ferrow_line "$(ferrow_repos)" "$(ferrow_json "$1")" |
    sed -nE 's/^  "([^"\\]|\\.)*": "(([^"\\]|\\.)*)".*/\2/p'
}

# Files a repo root under a workspace in repos.json; an empty workspace
# drops the binding.
ferrow_bind() {
  _fvalue=""
  [ -n "$2" ] && _fvalue="\"$(ferrow_json "$2")\""
  ferrow_write_line "$(ferrow_repos)" repos 1 "$(ferrow_json "$1")" "$_fvalue"
}

# The workspace for a directory and why (decision order of wiki §17.4):
#
#   env         FERROW_WORKSPACE
#   ferrow.toml the repo's `workspace = "…"`
#   binding     repos.json, written by /ferrow:connect
#   only        nothing declared, and one token on file
#   none        nothing declared, and no token on file
#   several     nothing declared, and several tokens on file: not connected
#
# Sets ferrow_ws, ferrow_why, ferrow_token (from the file; never another
# workspace's), ferrow_agent, and ferrow_envok: whether FERROW_AGENT_TOKEN
# may stand in. It may on a machine with no token on file — one set up by
# hand, as Codex, Hermes and CI are — and under the daemon, which runs one
# agent by that token. Once /ferrow:connect has filed a token, a declared
# workspace without one is not connected to it, whatever FERROW_AGENT_TOKEN
# holds: that variable is often set for every shell, for another workspace.
ferrow_resolve() {
  ferrow_migrate
  _fdir="${1:-$(pwd)}"
  ferrow_ws="" ferrow_why="" ferrow_token="" ferrow_agent="" ferrow_envok=""
  if [ -n "$FERROW_WORKSPACE" ]; then
    ferrow_ws="$FERROW_WORKSPACE" ferrow_why=env
  else
    ferrow_ws="$(ferrow_map_workspace "$(ferrow_map_file "$_fdir")")"
    if [ -n "$ferrow_ws" ]; then
      ferrow_why=ferrow.toml
    else
      ferrow_ws="$(ferrow_bound "$(ferrow_repo_root "$_fdir")")"
      [ -n "$ferrow_ws" ] && ferrow_why=binding
    fi
  fi
  _fcount="$(ferrow_workspaces | grep -c .)"
  if [ -z "$ferrow_ws" ]; then
    case "$_fcount" in
      0) ferrow_why=none ;;
      1) ferrow_ws="$(ferrow_workspaces)" ferrow_why=only ;;
      *) ferrow_why=several ;;
    esac
  fi
  if [ -n "$ferrow_ws" ]; then
    _fentry="$(ferrow_entry "$ferrow_ws")"
    ferrow_token="$(ferrow_field "$_fentry" token)"
    ferrow_agent="$(ferrow_field "$_fentry" agent_name)"
  fi
  if [ -n "$FERROW_DAEMON" ] || [ "$_fcount" = 0 ]; then
    ferrow_envok=1
  fi
  return 0
}
