// The pure half of repo-map.mjs: ferrow.toml parsing and path matching, with
// no Node imports, so the mod (hooks/register.js) reads the map with them too.
export const MAP_FILE = 'ferrow.toml';

function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '#') return line.slice(0, i);
  }
  return line;
}

function depth(text) {
  let quote = null;
  let open = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '[') open++;
    else if (c === ']') open--;
  }
  return open;
}

function strings(text, line) {
  const found = [];
  let rest = text.trim();
  while (rest.length) {
    const m = rest.match(/^"((?:[^"\\]|\\.)*)"|^'([^']*)'/);
    if (!m) throw new Error(`line ${line}: expected a quoted string`);
    found.push(m[1] !== undefined ? JSON.parse(`"${m[1]}"`) : m[2]);
    rest = rest.slice(m[0].length).trim();
    if (rest.startsWith(',')) rest = rest.slice(1).trim();
    else if (rest.length) throw new Error(`line ${line}: expected a comma`);
  }
  return found;
}

function value(text, line) {
  const v = text.trim();
  if (v.startsWith('[')) {
    if (!v.endsWith(']')) throw new Error(`line ${line}: an array is not closed`);
    return strings(v.slice(1, -1), line);
  }
  const [one, ...more] = strings(v, line);
  if (one === undefined || more.length) throw new Error(`line ${line}: expected one string`);
  return one;
}

/** The `[[map]]` entries of ferrow.toml text: `{paths, page, block?}`. */
export function parseRepoMap(text) {
  const entries = [];
  let current = null;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const at = i + 1;
    const line = stripComment(lines[i]).trim();
    if (!line) continue;
    if (line === '[[map]]') {
      current = {};
      entries.push(current);
      continue;
    }
    if (line.startsWith('[')) {
      current = null;
      continue;
    }
    const m = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.*)$/);
    if (!m) throw new Error(`line ${at}: expected key = value`);
    let raw = m[2];
    while (depth(raw) > 0 && i + 1 < lines.length) raw += ' ' + stripComment(lines[++i]).trim();
    if (current) current[m[1]] = value(raw, at);
  }
  entries.forEach((entry, n) => {
    const paths = Array.isArray(entry.paths) ? entry.paths.filter((p) => p.trim()) : [];
    if (!paths.length || typeof entry.page !== 'string' || !entry.page.trim()) {
      throw new Error(`[[map]] number ${n + 1} needs \`paths\` and \`page\``);
    }
    if (entry.block !== undefined && typeof entry.block !== 'string') {
      throw new Error(`[[map]] number ${n + 1}: \`block\` is a string`);
    }
  });
  return entries;
}

function glob(p, t) {
  if (!p.length) return !t.length;
  if (p.startsWith('**/')) {
    const rest = p.slice(3);
    if (glob(rest, t)) return true;
    for (let i = 0; i < t.length; i++) if (t[i] === '/' && glob(rest, t.slice(i + 1))) return true;
    return false;
  }
  if (p.startsWith('**')) {
    for (let i = 0; i <= t.length; i++) if (glob(p.slice(2), t.slice(i))) return true;
    return false;
  }
  if (p[0] === '*') {
    const end = t.includes('/') ? t.indexOf('/') : t.length;
    for (let i = 0; i <= end; i++) if (glob(p.slice(1), t.slice(i))) return true;
    return false;
  }
  if (p[0] === '?') return t.length > 0 && t[0] !== '/' && glob(p.slice(1), t.slice(1));
  return t[0] === p[0] && glob(p.slice(1), t.slice(1));
}

/** Whether a path relative to the repo root is one of the pattern's files. */
export function pathMatches(pattern, path) {
  const p = pattern.trim().replaceAll('\\', '/').replace(/^(\.\/)+/, '').replace(/^\/+/, '');
  return p.length > 0 && glob(p, path.replaceAll('\\', '/'));
}

/** The files a hook input touched: `file_path`, `path`, or a patch's file lines. */
export function touchedPaths(input) {
  const tool = input?.tool_input;
  for (const field of ['file_path', 'path']) {
    const path = tool?.[field];
    if (typeof path === 'string' && path.trim()) return [path.trim()];
  }
  const texts =
    typeof tool === 'string' ? [tool] : Object.values(tool ?? {}).filter((v) => typeof v === 'string');
  const paths = [];
  for (const line of texts.flatMap((t) => t.split('\n'))) {
    const m = line.trim().match(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/);
    if (m && !paths.includes(m[1].trim())) paths.push(m[1].trim());
  }
  return paths;
}

const targetKey = (entry) => `${entry.page.trim().toLowerCase()}\u0000${entry.block?.trim() ?? ''}`;

/** The entries that name a target an earlier one already does: `{entry, first}`, from 1. */
export function duplicateTargets(entries) {
  const seen = new Map();
  const found = [];
  entries.forEach((entry, n) => {
    const key = targetKey(entry);
    if (seen.has(key)) found.push({ entry: n + 1, first: seen.get(key) });
    else seen.set(key, n + 1);
  });
  return found;
}

/** Whether any of the entries maps `path` (relative to the map's directory). */
export function isMapped(entries, path) {
  return entries.some((entry) => entry.paths.some((pattern) => pathMatches(pattern, path)));
}

const tomlString = (text) => JSON.stringify(String(text));

/** A `[[map]]` entry for `path` and a suggested page, ready to paste into ferrow.toml. */
export function pasteBlock(path, candidate) {
  const title = String(candidate?.title ?? '').replace(/\s+/g, ' ').trim();
  const page = candidate?.page ?? '';
  const lines = ['[[map]]', `paths = [${tomlString(path)}]`, `page = ${tomlString(page)}${title ? `  # ${title}` : ''}`];
  if (candidate?.block) lines.push(`block = ${tomlString(candidate.block)}`);
  return lines.join('\n');
}
