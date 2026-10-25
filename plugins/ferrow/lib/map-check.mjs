// Checks a repo's ferrow.toml for a pre-commit hook or CI (wiki `14 · Agent layer`
// §10.2): the file parses, every path pattern matches a file of the repo,
// no two entries name the same page and block, and, with --server, every
// page and block exists. Exit 0 when all hold, 1 when one does not, 2 when
// the check itself could not run.
//
//   node plugin/ferrow/lib/map-check.mjs --repo . [--server URL --token TOKEN]
//
// The token defaults to FERROW_AGENT_TOKEN; it needs wiki:read.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MAP_FILE, duplicateTargets, parseRepoMap, pathMatches } from './repo-map-core.mjs';

const SKIP = new Set(['.git', 'node_modules', 'target']);

function walk(root, dir = root, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(root, path, out);
    else out.push(relative(root, path).split(sep).join('/'));
  }
  return out;
}

/** The repo's files relative to `root`: git's tracked and unignored ones, else a walk. */
export function repoFiles(root) {
  try {
    const listed = execFileSync('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 256 * 1024 * 1024,
    });
    return listed.split('\0').filter(Boolean);
  } catch {
    return walk(root);
  }
}

const target = (entry) => `page "${entry.page.trim()}"${entry.block?.trim() ? ` block ${entry.block.trim()}` : ''}`;

/** The offline checks: `{entries, problems: [{entry?, kind, text}]}`. */
export function checkMap(text, files) {
  let entries;
  try {
    entries = parseRepoMap(text);
  } catch (error) {
    return { entries: [], problems: [{ kind: 'parse', text: `${MAP_FILE} does not parse: ${error.message ?? error}` }] };
  }
  const problems = [];
  entries.forEach((entry, n) => {
    for (const pattern of entry.paths.filter((p) => p.trim())) {
      if (!files.some((file) => pathMatches(pattern, file))) {
        problems.push({ entry: n + 1, kind: 'unmatched', text: `[[map]] ${n + 1}: "${pattern}" matches no file` });
      }
    }
  });
  for (const { entry, first } of duplicateTargets(entries)) {
    problems.push({ entry, kind: 'duplicate', text: `[[map]] ${entry}: same target as [[map]] ${first} (${target(entries[entry - 1])})` });
  }
  return { entries, problems };
}

const STATUS = {
  page_unknown: (row) => `no page "${row.page}" on the server`,
  page_ambiguous: (row) => `more than one page is titled "${row.page}"; name it by id`,
  block_unknown: (row) => `page "${row.title ?? row.page}" has no block ${row.block}`,
};

/** The server's checks of the pages and blocks: problems, as `checkMap` gives them. */
export async function checkServer(text, server, token, fetchImpl = fetch) {
  const res = await fetchImpl(`${server.replace(/\/+$/, '')}/agent/repo-map/check`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ repo_map: text }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error?.code ?? `http_${res.status}`);
  return (body?.entries ?? [])
    .filter((row) => STATUS[row.status])
    .map((row) => ({ entry: row.entry, kind: row.status, text: `[[map]] ${row.entry}: ${STATUS[row.status](row)}` }));
}

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!['--repo', '--server', '--token'].includes(flag) || argv[i + 1] === undefined) {
      throw new Error(`unknown or incomplete argument: ${flag}`);
    }
    out[flag.slice(2)] = argv[++i];
  }
  if (!out.repo) throw new Error('--repo <path> is required');
  return out;
}

/** Runs the check and prints the report; the exit code. */
export async function main(argv, io = {}) {
  const say = io.out ?? ((line) => process.stdout.write(`${line}\n`));
  const env = io.env ?? process.env;
  let opts;
  try {
    opts = args(argv);
  } catch (error) {
    say(`map-check: ${error.message}`);
    say('usage: map-check.mjs --repo <path> [--server <url> --token <token>]');
    return 2;
  }
  const root = resolve(opts.repo);
  const file = join(root, MAP_FILE);
  if (!existsSync(file)) {
    say(`${MAP_FILE}: not found in ${root}`);
    return 1;
  }
  const text = readFileSync(file, 'utf8');
  const { entries, problems } = checkMap(text, io.files ?? repoFiles(root));
  if (opts.server && !problems.some((p) => p.kind === 'parse')) {
    const token = opts.token ?? env.FERROW_AGENT_TOKEN;
    if (!token) {
      say('map-check: --server needs --token or FERROW_AGENT_TOKEN');
      return 2;
    }
    try {
      problems.push(...(await checkServer(text, opts.server, token, io.fetch)));
    } catch (error) {
      say(`map-check: the server did not answer the check (${error.message ?? error})`);
      return 2;
    }
  }
  problems.sort((a, b) => (a.entry ?? 0) - (b.entry ?? 0));
  const noun = entries.length === 1 ? 'entry' : 'entries';
  if (problems.length === 0) {
    say(`${MAP_FILE}: ${entries.length} ${noun}, OK${opts.server ? '' : ' (pages not checked: no --server)'}`);
    return 0;
  }
  say(`${MAP_FILE}: ${entries.length} ${noun}, ${problems.length} ${problems.length === 1 ? 'problem' : 'problems'}`);
  for (const problem of problems) say(`  ${problem.text}`);
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
