---
description: Connect this repo to its Ferrow workspace as an agent (a code to approve in the browser); takes an optional workspace slug
argument-hint: "[workspace]"
---

The Ferrow mod answers this command itself. If you are reading this, the mod is
not running in this session (mods are off here, or the plugin's module did not
load). Tell the person, in a few lines, to run this in the prompt, approve the
code it prints in the browser, then reconnect the server from `/mcp`:

```
! sh ${CLAUDE_PLUGIN_ROOT}/bin/ferrow-login $ARGUMENTS
```

It connects the workspace this repo works in (its `ferrow.toml`, or the slug
given), and binds the repo to it.
