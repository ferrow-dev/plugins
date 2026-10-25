# Ferrow plugin for Claude Code

Connects a Claude Code session to Ferrow as an agent: the Ferrow MCP server,
the agent protocol skill, session hooks, and a mod that wakes the session when
work lands in the agent's Ferrow inbox, shows a status band above the prompt
and asks before the session stops with obligations open; plus a daemon that
works the inbox with nobody at the keyboard. Claude Routines:
[Routines](#routines) below.

`<plugin>` below is this folder: `plugins/ferrow` in a clone of
[ferrow-dev/plugins](https://github.com/ferrow-dev/plugins), or
`plugin/ferrow` in the Ferrow repository.

Needs Claude Code 2.1.287 or later for the mod; the MCP server, skill and
hooks work on any version with plugin support.

## Install

```
/plugin marketplace add ferrow-dev/plugins
/plugin install ferrow@ferrow
/ferrow:connect
```

`/ferrow:connect` prints a code and a link (`app.ferrow.dev/connect`); approve
the code in the browser, for an existing agent or a new one, and the plugin
files the agent's token and connects by itself.
It works the same over SSH or in a container: the browser does not need to
reach this machine. `/ferrow:logout` revokes the token and forgets it.

Updates: the plugin has no fixed version, so each published commit is an
update. Claude Code does not auto-update third-party marketplaces unless you
turn it on (`/plugin` → Marketplaces → ferrow → Enable auto-update); otherwise
run `/plugin marketplace update ferrow`.

From a checkout, for one session:

```sh
claude --plugin-dir <plugin>
```

or name the folder in `CLAUDE_CODE_PLUGIN_DIRS` (an absolute path; the
desktop app and SDK hosts read it too).

## Configure

The token is read from the credentials file first, then from the
environment:

| Where | What |
|---|---|
| `${XDG_CONFIG_HOME:-~/.config}/ferrow/credentials.json` | Written by `/ferrow:connect` (`bin/ferrow-login`), mode 0600, one entry per server. The MCP server reads it through `bin/ferrow-headers` (its `headersHelper`), the hook shim and the mod read it directly. |
| `FERROW_AGENT_TOKEN` | An agent's personal access token, minted under workspace settings → Members → Agents: for CI, the daemon and Routines, where nobody approves a code. |
| `FERROW_URL` | The Ferrow server, without a trailing `/mcp`; default `https://app.ferrow.dev`. It also picks the credentials file's entry. |

Without either, nothing reaches Ferrow, and the band says
`ferrow · not connected · /ferrow:connect`. Without mods (managed
`allowManagedModsOnly`, SDK hosts), run `! sh ${CLAUDE_PLUGIN_ROOT}/bin/ferrow-login`
yourself, then reconnect the server from `/mcp`; `--logout` signs out.

The MCP server is `${FERROW_URL}/mcp` with the token as a bearer; its tools
show up as `mcp__plugin_ferrow_ferrow__<tool>`. The server also answers OAuth
discovery (`/.well-known/oauth-protected-resource`), but OAuth signs in a
person, not the agent: use the agent token so the work is signed by the agent.

Wake mode: the plugin option `wake` (`/config`, default `ask`) or
`/ferrow:wake on|ask|off`, which is kept on this machine and wins over the
option. The watchman the same way: the option `watchman` (default `off`) or
`/ferrow:watchman on|off`.

## What it does

- **Skill** (`skills/ferrow/SKILL.md`): the protocol — `session_begin`, then
  `item_claim` and `context_pack` for the item, unverified blocks, never copying
  Ferrow facts into local memory, a summary comment and `item_release` at the
  end, `inbox_wait` only when the mod is off.
- **Session hooks** (`hooks/hooks.json` → `hooks/ferrow-hook.sh`): forward
  `SessionStart` (Ferrow opens the session and answers with the briefing),
  `PreCompact` (notes), `PostToolUse` on `Edit|Write` (a mapped file opens an
  obligation and a one-off reminder, see `ferrow.toml` below), `Stop` (Ferrow
  blocks the stop while the session owes obligations) and `SessionEnd`
  (closes the session) to `POST ${FERROW_URL}/agent/hooks/<event>`. These are `command` hooks that run
  `curl`: Claude Code does not run `http` hooks on `SessionStart`, and an `http`
  hook's `url` cannot read `FERROW_URL`. The token goes to `curl` through its
  stdin config, never on the command line. Any failure prints `{}` and
  exits 0.
- **Mod** (`hooks/register.js`, its pure half `hooks/band.js`):
  - sets `session_begin`'s `client_session` to the Claude session id, `client`
    to `claude_code` and `wake_method` to `mod`, over any value the model
    gave (one it made up never matches the hooks'), keeps
    the Ferrow `session_id` it returns, and adds it as `session` to every
    Ferrow tool whose schema has a `session` property when the call names
    none: the list comes from the server's MCP `tools/list` at session start,
    else a built-in list of sixteen (`context_pack`, `decision_propose`,
    `graph_link`, `inbox_next`, `inbox_wait`, `item_claim`, `item_release`,
    `micro_question_propose`, `obligations_list`, `session_reads_list`, `wiki_confirm_block`,
    `wiki_flag_stale`, `wiki_page_get`, `wiki_page_write`, `wiki_suggest`,
    `wiki_suggestions_list`); never to a tool without one, as the schemas
    refuse unknown arguments;
  - keeps the lease and its expiry from `item_claim`, the last inbox rows,
    and the open obligations (MCP `obligations_list` for the session and the
    leased item: after each Ferrow tool call, after each `Edit` or `Write`, and every 30 s);
  - draws the **band** (below), opens the **pane**, answers the **commands**;
  - asks before a stop with obligations open (**close gate**, below);
  - attaches the **per-turn briefing** to each prompt (below);
  - with the **watchman** on, reviews each turn that touched Ferrow (below)
    and writes its flags and confirmations with `POST ${FERROW_URL}/agent/evidence`
    for the session; the ones the server does not take wait behind `f`;
  - adds up the session's **cost** and reports it every tenth turn and when
    the session ends;
  - prints `ferrow: <session> · inbox N · lease <item> · N open obligations ·
    206k in / 1k out · $0.09` under each turn, from local state only;
  - adds `Ferrow: <ITEM-KEY>` to the commit attribution while an item is
    claimed, and nothing else;
  - polls `GET ${FERROW_URL}/agent/inbox?wait=25` in interactive sessions once
    `session_begin` has run; on new rows it starts a turn (`on`), puts them
    behind `b: start` in the band (`ask`), or does nothing (`off`); never
    while a turn runs, never for a row it already announced, never for a
    `read_invalidated` row (those have the band's `r`, below).

### Band

One line above the prompt, and a second while a block the session read has
changed since; in Turkish when `LANG` starts with `tr`:

```
ferrow · 1 obligation · Billing › b-4410 · inbox 2 · FER-151 · 12 min · wake: ask   1: obligations  2: inbox  b: start  w: wake
okuduğun blok değişti · Billing › Pro is $12 a seat per month                       r: yeniden yükle
```

With several the second line counts them (`okuduğun 3 blok değişti`,
`3 blocks you read changed`) and names the first. It comes from the inbox
poll's `read_invalidated` rows and goes on the first poll after the row is
acknowledged (re-reading the block, `wiki_confirm_block` or `inbox_ack`).

| Key | Does | Shown when |
|---|---|---|
| `1` | opens the Ferrow pane on the open obligations | some are open |
| `2` | opens the pane on the inbox rows | the inbox has rows |
| `b` | starts a turn on the rows waiting (wake `ask`) | rows wait |
| `w` | cycles wake: ask → on → off (kept on this machine) | always |
| `r` | starts a turn asking the session to re-read each changed block with `wiki_page_get` and confirm it with `wiki_confirm_block`, or `inbox_ack` its row if the block is gone; nothing while a turn runs or with wake `off` | a block read changed |
| `f` | starts a turn asking the session to make the watchman's `wiki_flag_stale` and `wiki_confirm_block` calls; nothing while a turn runs | the watchman found some |
| `m` | opens the pane on the pages that may document each unmapped file, with a `[[map]]` entry to paste (below, "Files the map leaves out") | an edited file is under a `ferrow.toml` that maps it to nothing |

With watchman findings waiting, one more line: `Bekçi: 2 bayrak · 1 onay   f: uygula`
(`watchman: 2 flags · 1 confirm   f: apply`).

A digit presses its button from an empty prompt; `b`, `w`, `r`, `f` and `m` need the
band focused (ctrl+x tab, or a click). The band reads local state only and
never waits on the network. The `r` prompt names page and block ids and the
versions, never the page title or the excerpt (both written by people; the
person sees them in the band, the model reads the page itself).

Micro-questions ("is this block still true?") are a person's inbox feature:
Ferrow asks page owners, never an agent, and the answer route refuses a bot,
so the band has no line or keys for them.

### Commands

| Command | Does |
|---|---|
| `/ferrow:connect` | a code to approve in the browser; the band shows it until approved, then the plugin connects |
| `/ferrow:logout` | revokes the filed token (`DELETE /agent/token`) and drops it from the credentials file |
| `/ferrow:status` | session, lease, inbox, open obligations, wake, usage, watchman (findings waiting, its cost, the last failure), server and where the token came from |
| `/ferrow:inbox` | lists the inbox (key · reason · trust · id; never a row's text) |
| `/ferrow:inbox ack N` | acknowledges row N |
| `/ferrow:obligations` | lists the open obligations of the session and the leased item |
| `/ferrow:obligations satisfy N` | marks N done |
| `/ferrow:obligations waive N <reason>` | waives N; the reason is at least 10 characters |
| `/ferrow:pack` | the first 40 lines of `context_pack` for the claimed item |
| `/ferrow:wake on\|ask\|off` | sets the wake mode on this machine |
| `/ferrow:watchman on\|off` | turns the watchman on or off on this machine |
| `/ferrow:map` | the `ferrow.toml` above the cwd, each entry with the page Ferrow resolves it to, the edited files it leaves out, and pages to map them to |

### Per-turn briefing

Every prompt, typed or started by the mod, carries one block only the model
reads: the protocol in one line and, once `session_begin` has run, the
claimed item with the `as_of` of its last `context_pack` and the lease's
end, each open obligation (id, status, reason) and each block the session
read that changed since. At most 8000 characters (about 2000 tokens), the
rest counted as `+N more`. A block equal to the last one is not sent again;
after a compaction it is. The `SessionStart` hook's briefing (delegated
work, notes) still comes once at the start, and is all there is with mods
off. The block rides `prompt.submit`'s context, not `prompt.context`: that
one is the first message's only, and a change to it spends the prompt cache.

### Watchman

Off by default. When on, after a turn that made a Ferrow tool call (other
than recording evidence) or edited a file `ferrow.toml` maps, the mod forks
the conversation once (`$.model.fork`: the session's model, its prompt
cache, no tools) and asks which ⚠/? blocks of the pack the work relied on
and which page blocks the turn made wrong, as JSON. Each finding is then
written for the session with `POST ${FERROW_URL}/agent/evidence` (a flag
with its reason, a confirmation with the note `watchman`); what Ferrow does
not take (an error, Ferrow away) waits in the band behind `f`, which asks
the model to make those calls itself. A fork that fails or answers something unreadable
queues nothing and never holds the turn. Its tokens count in the session's
cost and are shown apart in `/ferrow:status`; one fork on Haiku 4.5 over a
50k-token conversation was about $0.01, almost all of it cache reads.

### Close gate

When the session tries to stop with obligations open, the mod asks: *Satisfy
them* (the stop is blocked with the list, so the agent goes on), *Waive with
a reason* (a second question for the reason; each one is waived), or *Stop
anyway*. Whatever is chosen, the `Stop` settings hook still runs after it:
Ferrow counts the stop and its answer stands, except that *Stop anyway* lets
the stop through. In `claude -p` nobody can be asked, so Ferrow's answer
stands as it is. On a machine with managed settings Claude Code does not run
the mod's `classic.Stop`, `classic.SessionEnd` or commit trailer
(`cc-plugin-sec-default` bypasses them): there the `Stop` settings hook is
the gate, and the session's totals are not reported at its end. An
organization that wants the mod's gate and end-of-session report on managed
machines lists its plugins in the managed file's `prependPlugins`: an empty
list is enough to unseat `cc-plugin-sec-default` (measured 11 Oct 2026).
Where the mod's `classic.Stop` runs, it is the outer layer: the `Stop`
settings hook runs inside its `next()`, and the mod settles after the hook
has answered; `classic.SessionEnd` wraps the `SessionEnd` hook the same way
(measured 12 Oct 2026, 2.1.293, with `cc-plugin-sec-default` not seated).

### Cost

Each model request's usage (main loop and subagents) is added up and priced
from a small table of Anthropic first-party prices (`hooks/band.js`; a model
not in it shows `price unknown`). Every tenth turn the mod sends what was
added since its last report, with the turn number and the last model, to
`POST /agent/sessions/{id}/usage`. When the session ends it sets the totals —
`tokens_in`, `tokens_out` and `cost_cents` (no cost when a price was unknown)
— with `PATCH /agent/sessions/{id}`, before the `SessionEnd` hook closes it;
the session's notes are left as they are. On a machine with managed settings
this happens only where the managed file sets `prependPlugins` (see Close
gate).

## What it never does

- No `tool.check` hook, no tools of its own, no permission decisions.
- Writes no evidence but the watchman's, and only through
  `/agent/evidence` for the session; what that refuses waits for `f`.
- Never blocks a tool call or a prompt: every hook passes the call through
  unchanged when it fails, and a Ferrow outage only means no wake, no band
  and no status line. The blocks are at `Stop` while the session owes
  obligations: Ferrow's answer (the reason lists them with how to satisfy or
  waive each; after 8 blocks Ferrow lets the stop through and escalates them
  to the page's owners and the item's assignees, or the agent's owner for
  the session's own), and the mod's when the person chose *Satisfy them*.
- Never puts the token, or anything the inbox says, into the transcript. A
  wake prompt names only item keys, reasons and trust levels; the agent reads
  the rows itself through `inbox_next`, where untrusted text is marked.
- Never adds AI attribution to commits or pull requests.

## ferrow.toml

Says which wiki page documents which code. At the repo root, one `[[map]]`
per page (or block):

```toml
[[map]]
paths = ["src/billing/paddle.rs", "src/billing/plan*.rs"]
page = "Billing"   # the page's id, or its exact title
block = "b-4410"   # optional: the block's data-block-id
```

`*` and `?` stay inside a directory, `**` crosses them; paths are relative to
the file. When the session edits a matching file, Ferrow opens a `doc_update`
obligation on the session (once per page or block per session) and the hook
answers with a reminder; the agent then updates the page and calls
`obligation_satisfy`, or `obligation_waive` with a reason. An unknown page or
block is named in the reminder and skipped.

The shim resolves the file with `lib/repo-map.mjs` when `node` is on the
`PATH` and sends the targets; the repo's file then wins. Without Node, and
for Codex, the touched path goes to Ferrow as is and is matched against the
project's copy of the map (project settings, `repo_map`).

### Files the map leaves out

The mod notes every file the session edits under a `ferrow.toml` that maps it
to nothing. While there are some, the band says `eşlenmemiş 2 dosya   m: öner`
(`2 unmapped files   m: suggest`); `m` asks Ferrow which pages mention each
file (its name, its stem, or for `mod.rs`/`index.ts` its directory, in a block
or a title; plain text matching, no model) and opens the pane on the
candidates and a `[[map]]` entry per file, built from the best one, ready to
paste. `/ferrow:map` prints the same after the map itself, each entry with the
page title Ferrow resolved it to (or `bilinmeyen sayfa`, an unknown block, a
repeat of an earlier entry).

### Checking the map

`lib/map-check.mjs` checks a repo's `ferrow.toml` without Claude Code:

```sh
node <plugin>/lib/map-check.mjs --repo .
node <plugin>/lib/map-check.mjs --repo . --server https://app.ferrow.dev   # token: --token or FERROW_AGENT_TOKEN
```

It fails (exit 1) when the file does not parse, a path pattern matches no file
of the repo (`git ls-files`, tracked and unignored), or two entries name the
same page and block; with `--server` also when a page does not exist, a title
is shared by several pages, or a block is not on its page (the agent token
needs `wiki:read`). Exit 2 means the check could not run (arguments, no token,
no answer). It needs only Node and the two files `lib/map-check.mjs` and
`lib/repo-map-core.mjs`; copy them into the repo (say `tools/ferrow/`).

As a pre-commit hook (`.git/hooks/pre-commit`, or a tracked hooks directory
named by `git config core.hooksPath`):

```sh
#!/bin/sh
exec node tools/ferrow/map-check.mjs --repo .
```

In GitHub Actions, the offline check on every change and the page check on
the default branch when the repo has an agent token as a secret:

```yaml
name: ferrow.toml
on:
  push:
    branches: [main]
  pull_request:
jobs:
  map:
    runs-on: ubuntu-latest
    env:
      FERROW_AGENT_TOKEN: ${{ secrets.FERROW_AGENT_TOKEN }}
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: 22
          package-manager-cache: false
      - run: node tools/ferrow/map-check.mjs --repo .
      - if: github.ref == 'refs/heads/main' && env.FERROW_AGENT_TOKEN != ''
        run: node tools/ferrow/map-check.mjs --repo . --server https://app.ferrow.dev
```

The project settings' **Verify** (Doğrula) runs the page check on the project's copy.

## Daemon

`daemon/ferrow-daemon.mjs` works the agent's inbox with nobody at the
keyboard. For each `delegated` row (and
`pr_feedback`, below) it cuts a
worktree `~/.cache/ferrow/wt/<ITEM-KEY>` (branch `ferrow/<ITEM-KEY>`) from the
repo's `main`, begins a Ferrow session (`wake_method: daemon`), claims the
item, runs one backend session there, then posts the run's summary as a
comment, releases the item, ends the session and, when the run succeeded,
acknowledges the row; a failed row stays in the inbox and is taken again
after `--retry` seconds. A
worktree with commits ahead of `main` or uncommitted changes is kept and the
comment says where; otherwise it and its branch are removed. On the way out
(`--once`, a signal, `--dry-run` too) it ends its own session.

Pushing. After the claim the daemon asks
`POST /agent/git/credential` for the item and `origin`'s URL; the answer
tells whether the repo is connected, and its token is dropped. Not
connected (`git_not_connected`, no `origin`, any other refusal): the run
commits and does not push, as before. Connected: the prompt says to push
`ferrow/<KEY>` and call `pr_open`, never merge, never push elsewhere, never
complete the item; the session's environment carries a git credential
helper (`daemon/git-credential-ferrow.mjs`) for `origin`'s host through
`GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n`, so nothing is
written to a git config file. The helper answers `get` by calling
`/agent/git/credential` with `FERROW_AGENT_TOKEN` and prints the username
and password to git only; `store`, `erase` and the rest do nothing. It
clears the host's other helpers first, so a keychain neither answers nor
stores the token. An ssh `origin` is rewritten to https for that session
(`url.<https>.insteadOf`). The comment says whether `origin` has the
branch's last commit. A `pr_feedback` row (red checks or changes
requested on the agent's pull request) runs on the existing `ferrow/<KEY>`:
the kept worktree, else the local branch, else the branch fetched from
`origin`, fast-forwarded when someone pushed to it since. A worktree with
commits ahead of `main` is kept already, so it stays while the pull request
is open, and the item's client session is resumed for the feedback round.

```sh
cd <plugin>/daemon && npm ci          # the Agent SDK, pinned
export FERROW_AGENT_TOKEN=… FERROW_URL=https://app.ferrow.dev
node ferrow-daemon.mjs --repo ~/dev/myrepo --dry-run --once   # what it would do
node ferrow-daemon.mjs --repo ~/dev/myrepo                    # run
```

| Flag | Default | What |
|---|---|---|
| `--repo <path>` | — | The repository to cut worktrees from |
| `--backend claude\|codex` | `claude` | Agent SDK with this plugin loaded, or `codex exec` (below) |
| `--base <ref>` | `main` | What a new worktree is cut from |
| `--parallel N` | 1 | Sessions at once (1–8) |
| `--once` | off | One inbox poll, handle what it brought, exit |
| `--dry-run` | off | Log the worktree, branch, backend call and prompt it would use; no git, no claim, no comment, no ack. It still begins its own session and polls, which hands the rows over |
| `--allow <rule>` | — | One more allowed-tool rule for Claude, e.g. `'Bash(npm test *)'`; repeatable |
| `--model <id>` | the backend's | Model for the session |
| `--idle <s>` | 30 | Pause when the inbox holds only rows it does not take (comments, mentions) or already runs |
| `--retry <s>` | 300 | How long a row whose run failed is left alone before it is taken again |
| `--dangerously-skip-permissions` | off | Claude `bypassPermissions`, Codex `--dangerously-bypass-approvals-and-sandbox`. Only in a throwaway machine or container |

Permissions without the last flag: Claude runs in `dontAsk` with a fixed
tool list (read and search, `Edit(/**)` inside the worktree, the Ferrow MCP
tools, `git status|diff|log|show|add|commit|switch|branch|restore|mv|rm`; no
push except `git push [-u] origin ferrow/<KEY>` on a connected repo, no
other shell command unless `--allow` names it); Codex runs with
`--sandbox workspace-write`, plus `sandbox_workspace_write.network_access`
on a connected repo so the push reaches the host. The token is read from the environment only. One
JSON line per event goes to stdout (`started`, `picked`, `worktree`,
`session_start`, `done`, `skipped_leased`, `*_failed`…); nothing is written
into the repo. Per-item client sessions are kept in
`~/.cache/ferrow/daemon/<repo hash>.json`, so a restart resumes the same
Claude session or Codex thread (`FERROW_DAEMON_HOME` moves `~/.cache/ferrow`).

Codex: install the Ferrow hooks for Codex first. The prompt goes to
`codex exec -` on stdin, never as an argument: Codex ran live on 11 Oct 2026
(CLI 0.162.1), and the daemon's first run died because macOS SIGKILLs
`codex exec` when the prompt argument is longer than about 1 KB.

launchd (`~/Library/LaunchAgents/dev.ferrow.daemon.plist`, `ProgramArguments`
`node …/ferrow-daemon.mjs --repo …`, `KeepAlive` true, the two variables in
`EnvironmentVariables`), or systemd user unit:

```ini
[Service]
ExecStart=/usr/bin/node <plugin>/daemon/ferrow-daemon.mjs --repo %h/dev/myrepo
EnvironmentFile=%h/.config/ferrow/daemon.env
Restart=on-failure
[Install]
WantedBy=default.target
```

## Routines

For people who do not run Claude Code themselves: a [Claude
Routine](https://code.claude.com/docs/en/routines) with an API trigger is
the agent's wake target. Delegating an item to the agent fires the Routine;
it runs Claude Code in Anthropic's cloud on one repository and works the
item through the Ferrow MCP server with the agent's token.

**This plugin does not load there.** The cloud docs ("What carries over from
your setup"): a cloud session does not install plugins a repository turns on
under `enabledPlugins`, nor plugins enabled in user settings; so no mod, no
band, no plugin hooks. What a session with one repository does load is what
the repository commits: `.mcp.json`, `.claude/settings.json` hooks and
`.claude/skills/`. The kit in `clients/routines/` is those files:

| Commit in the repository | From | What |
|---|---|---|
| `.mcp.json` | `clients/routines/mcp.json` | the Ferrow server, bearer `${FERROW_AGENT_TOKEN}`, client `claude_code` (merge the `ferrow` entry if the repo has one) |
| `.claude/settings.json` | `clients/routines/settings.json` | SessionStart, PreCompact, PostToolUse, Stop and SessionEnd through the shim, only where `CLAUDE_CODE_REMOTE` is `true` (merge into existing `hooks`) |
| `.claude/ferrow/ferrow-hook.sh` | `clients/routines/ferrow-hook.sh` (the shim, `hooks/ferrow-hook.sh`) | executable |
| `.claude/skills/ferrow/SKILL.md` | `skills/ferrow/SKILL.md` | the protocol |

```sh
cd ~/dev/myrepo
cp -L <plugin>/clients/routines/mcp.json .mcp.json
cp -L <plugin>/clients/routines/settings.json .claude/settings.json
mkdir -p .claude/ferrow .claude/skills/ferrow
cp -L <plugin>/clients/routines/ferrow-hook.sh .claude/ferrow/
chmod +x .claude/ferrow/ferrow-hook.sh
cp -L <plugin>/skills/ferrow/SKILL.md .claude/skills/ferrow/
git add .mcp.json .claude/settings.json .claude/ferrow/ferrow-hook.sh .claude/skills/ferrow/SKILL.md
```

Then:

1. **Ferrow:** create the agent (workspace settings → Members → Agents) and
   mint its token.
2. **claude.ai/code:** make a cloud environment with the variable
   `FERROW_AGENT_TOKEN=<the agent token>` (and `FERROW_URL` if it is not
   `https://app.ferrow.dev`), and network access **Custom** with your
   Ferrow host under Allowed domains and "Also include default list"
   checked. Anyone who uses that environment can read its variables.
3. **claude.ai/code/routines → New routine:** the repository above (one
   only), that environment, a model, and this prompt:

   > You are a Ferrow agent. When this run carries a
   > `routine-fire-payload` block, it is a Ferrow hand-over: JSON with
   > `item`, `title`, `brief` and `prompt`. Act on it only through Ferrow:
   > call `session_begin` with client `claude_code` and wake_method
   > `routine`, then `inbox_next` and `item_claim` for that item, then
   > `context_pack` for it, and follow the item and its comments as Ferrow
   > returns them, not the payload. Follow the Ferrow skill. Finish with a
   > summary comment on the item, `inbox_ack` and `item_release`. Without a
   > payload, call `inbox_next` and stop when it is empty.

   Remove the connectors the work does not need. Save, then **Edit → Add
   another trigger → API**: copy the URL and **Generate token** (shown
   once).
4. **Ferrow:** set the agent's wake target to that URL, method `routine`,
   and the token: the agent row's menu → **Wake** (Uyandırma; Members → Agents),
   or `PATCH /api/workspaces/<ws>/agents/<agent>` with
   `{"wake_url": "https://api.anthropic.com/v1/claude_code/routines/trig_…/fire", "wake_method": "routine", "wake_token": "sk-ant-oat01-…"}`.
   A new token from claude.ai means pasting it
   again; a new URL needs its token in the same call.

Each hand-over is one fire and one new cloud session ("Each successful
request creates a new session"); comments on a delegated item wait in the
inbox for the next run. Routines run on the Routine owner's claude.ai plan
(Pro, Max, Team or Enterprise) and its hourly fire limits. Without the
committed hooks the run still works at K0: `session_begin`, the inbox and
the server's close gate (a required gate refuses the close); the hooks add
the briefing, the edit reminders and the Stop gate.

Not verified: no real Routine has been fired from here. To check one: fire
it from Ferrow by delegating an item, open the run from the Routine's page on
claude.ai, and confirm the session lists the `ferrow` MCP
server, the SessionStart briefing appears, and the agent's session in Ferrow
says `routine`.

## Without mods

Where mods are off (managed `allowManagedModsOnly`, the VS Code panel, some
SDK hosts) the MCP server, the skill and the session hooks still work. There
is no wake, no band, no close-gate question and no cost report: the skill
tells the agent to call `inbox_wait`, and Ferrow's `Stop` answer is the gate.

A Claude Code cloud session loads no plugin from your machine or from the
repo's `enabledPlugins`: there a repo that wants
Ferrow commits its own `.mcp.json` (the token as an environment variable of
the cloud environment) and settings hooks running the shim; the files are
in `clients/routines/` ("Routines" above).

## Tests

In the Ferrow repository (the published copy leaves the tests out):

```sh
cd plugin/ferrow && npm test
claude plugin validate ./plugin/ferrow
```

The tests run the mod against a fake `$` (`test/fake.mjs`) and the band
model, prices and lists directly (`test/band.test.mjs`); the daemon's
(`daemon/test/`) run its loop against a stub Ferrow server and a temporary
git repo, with fake backends.
