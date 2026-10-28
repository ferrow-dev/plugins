---
description: Show the repo's ferrow.toml map, the edited files it leaves out, and pages to map them to; `create N` creates the page entry N names
argument-hint: "[create N]"
---

The Ferrow mod answers this command itself. If you are reading this, the mod is
not running in this session, so there is no list of edited files. Say so in one
line, and add that `node plugin/ferrow/lib/map-check.mjs --repo .` checks the
map (with `--server` and a token, its pages and blocks too). For `create N`,
create the page the map's entry N names with `wiki_page_create`, titled exactly
as the entry spells it, once `wiki_search` shows no page by that title.
