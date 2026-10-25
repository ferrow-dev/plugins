// Resolves a PostToolUse hook input against the repo's ferrow.toml and adds
// the result as `touched_targets` (wiki `14 · Agent layer` §10). Run by the hook
// shim as a filter: hook stdin in, the body to send out. With no ferrow.toml
// above the touched files the input goes out byte for byte, and the server
// matches the paths against the project's stored map instead.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MAP_FILE, parseRepoMap, pathMatches, touchedPaths } from './repo-map-core.mjs';

export { parseRepoMap, pathMatches, touchedPaths };

/** The directory holding the ferrow.toml above `dir`, stopping at a repo's root. */
export function findRoot(dir) {
  let at = resolve(dir);
  for (;;) {
    if (existsSync(join(at, MAP_FILE))) return at;
    if (existsSync(join(at, '.git'))) return null;
    const up = dirname(at);
    if (up === at) return null;
    at = up;
  }
}

/**
 * The body the shim sends for a PostToolUse input (a JSON string): the input
 * itself when no ferrow.toml covers the touched files, else the input with
 * `touched_targets` — empty when the map names none of them, which tells the
 * server not to fall back to its own — or `repo_map_error` when the file does
 * not parse.
 */
export function enrich(text, read = (path) => readFileSync(path, 'utf8')) {
  let input;
  try {
    input = JSON.parse(text);
  } catch {
    return text;
  }
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  const files = touchedPaths(input).map((path) => (isAbsolute(path) ? path : resolve(cwd, path)));
  const targets = [];
  let mapped = false;
  for (const file of files) {
    const root = findRoot(dirname(file));
    if (!root) continue;
    mapped = true;
    let entries;
    try {
      entries = parseRepoMap(read(join(root, MAP_FILE)));
    } catch (error) {
      return JSON.stringify({ ...input, repo_map_error: String(error.message ?? error) });
    }
    const path = relative(root, file).split(sep).join('/');
    for (const entry of entries) {
      if (!entry.paths.some((pattern) => pathMatches(pattern, path))) continue;
      const target = { page: entry.page.trim(), path };
      if (entry.block?.trim()) target.block = entry.block.trim();
      if (!targets.some((t) => t.page === target.page && t.block === target.block)) targets.push(target);
    }
  }
  if (!mapped) return text;
  return JSON.stringify({ ...input, touched_targets: targets });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const chunks = [];
  process.stdin.on('data', (chunk) => chunks.push(chunk));
  process.stdin.on('end', () => process.stdout.write(enrich(Buffer.concat(chunks).toString('utf8'))));
}
