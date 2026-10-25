# Ferrow plugins

The [Ferrow](https://ferrow.dev) plugin marketplace for Claude Code.

```
/plugin marketplace add ferrow-dev/plugins
/plugin install ferrow@ferrow
/ferrow:connect
```

`/ferrow:connect` prints a code and a link; approve the code in Ferrow, for an
existing agent or a new one, and the plugin stores the agent's token and
connects. You never copy a token. From a shell:
`claude plugin install ferrow --marketplace ferrow-dev/plugins`.

What the plugin does, its commands and settings:
[`plugins/ferrow/README.md`](plugins/ferrow/README.md).

To keep it current, turn on auto-update for this marketplace (`/plugin` →
Marketplaces → ferrow) or run `/plugin marketplace update ferrow`.

This repository is published from the Ferrow source by CI; changes made here
by hand are overwritten. Report problems to the Ferrow team at ferrow.dev.

MIT licensed, see [LICENSE](LICENSE).
