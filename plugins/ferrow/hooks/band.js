import { pasteBlock } from '../lib/repo-map-core.mjs'

const LIVE = ['open', 'proposed']

export const READ_INVALIDATED = 'read_invalidated'

const WORDS = {
  tr: {
    obligations: n => `${n} yükümlülük`,
    inbox: n => `Inbox ${n}`,
    minutes: n => `${n} dk`,
    wake: { on: 'uyandırma: açık', ask: 'uyandırma: sor', off: 'uyandırma: kapalı' },
    buttons: {
      obligations: 'yükümlülükler',
      inbox: 'Inbox',
      start: 'başla',
      wake: 'uyandırma',
      reload: 'yeniden yükle',
      apply: 'uygula',
      suggest: 'öner',
    },
    unmapped: n => `eşlenmemiş ${n} dosya`,
    map: {
      unmappedOne: path => `eşlenmemiş: ${path}`,
      suggestions: 'Öneriler (sayfa ya da blok metni dosyayı anıyor):',
      none: 'öneri yok',
      title: 'başlık',
      paste: 'ferrow.toml\'a yapıştırmaya hazır:',
      unknown: 'bilinmeyen sayfa',
      create: n => `bu başlıkla oluştur: /ferrow:map create ${n}`,
      created: title => `"${title}" sayfası oluşturuldu.`,
      exists: title => `"${title}" sayfası zaten var; oluşturulmadı.`,
      noEntry: n => `ferrow.toml'da ${n}. kayıt yok.`,
      ambiguous: 'aynı başlıkta birden çok sayfa',
      blockUnknown: 'bilinmeyen blok',
      duplicate: n => `${n}. kaydın tekrarı`,
      offline: 'sunucuya ulaşılamadı: sayfalar denetlenmedi',
      noMap: cwd => `${cwd} üstünde ferrow.toml yok; sunucu projenin kayıtlı haritasını kullanır.`,
      allMapped: 'Düzenlenen her dosya eşlenmiş.',
    },
    changed: n => (n === 1 ? 'okuduğun blok değişti' : `okuduğun ${n} blok değişti`),
    watch: (flags, confirms) => [flags && `${flags} bayrak`, confirms && `${confirms} onay`].filter(Boolean).join(' · '),
    watchman: 'Bekçi',
    none: 'yok',
    notConnected: 'bağlı değil',
    notConnectedTo: workspace => `${workspace} için bağlı değil`,
    several: known => `birden çok çalışma alanı (${known.join(', ')}), bu repo birini seçmiyor`,
    connecting: (code, url) => `kod ${code} · onayla: ${url}`,
  },
  en: {
    obligations: n => `${n} ${n === 1 ? 'obligation' : 'obligations'}`,
    inbox: n => `inbox ${n}`,
    minutes: n => `${n} min`,
    wake: { on: 'wake: on', ask: 'wake: ask', off: 'wake: off' },
    buttons: { obligations: 'obligations', inbox: 'inbox', start: 'start', wake: 'wake', reload: 'reload', apply: 'apply', suggest: 'suggest' },
    unmapped: n => `${n} unmapped ${n === 1 ? 'file' : 'files'}`,
    map: {
      unmappedOne: path => `unmapped: ${path}`,
      suggestions: 'Suggestions (a page or block whose text names the file):',
      none: 'no suggestion',
      title: 'title',
      paste: 'Ready to paste into ferrow.toml:',
      unknown: 'unknown page',
      create: n => `create with this title: /ferrow:map create ${n}`,
      created: title => `Created page "${title}".`,
      exists: title => `A page "${title}" is already there; nothing was created.`,
      noEntry: n => `ferrow.toml has no entry ${n}.`,
      ambiguous: 'several pages have this title',
      blockUnknown: 'unknown block',
      duplicate: n => `repeats entry ${n}`,
      offline: 'server unreachable: pages not checked',
      noMap: cwd => `No ferrow.toml above ${cwd}; the server uses the project's stored map.`,
      allMapped: 'Every edited file is mapped.',
    },
    changed: n => (n === 1 ? 'a block you read changed' : `${n} blocks you read changed`),
    watch: (flags, confirms) =>
      [flags && `${flags} ${flags === 1 ? 'flag' : 'flags'}`, confirms && `${confirms} ${confirms === 1 ? 'confirm' : 'confirms'}`]
        .filter(Boolean)
        .join(' · '),
    watchman: 'watchman',
    none: 'none',
    notConnected: 'not connected',
    notConnectedTo: workspace => `not connected to ${workspace}`,
    several: known => `several workspaces (${known.join(', ')}) and this repo names none`,
    connecting: (code, url) => `code ${code} · approve at ${url}`,
  },
}

export function words(lang) {
  return WORDS[lang] ?? WORDS.en
}

export function fit(text, width) {
  if (width <= 0) return ''
  if (text.length <= width) return text
  if (width === 1) return '…'
  return `${text.slice(0, width - 1)}…`
}

export function targetLabel(obligation) {
  const quoted = /"([^"]+)"/.exec(obligation.reason ?? '')
  if (quoted) return obligation.target_block ? `${quoted[1]} › ${obligation.target_block}` : quoted[1]
  return obligation.reason ?? obligation.id
}

/** Each list's rows, once; `item` is the key a row was listed under, kept
    when the same row came first without one. */
export function liveObligations(lists) {
  const seen = new Map()
  const out = []
  for (const one of lists.flat()) {
    if (!one || !LIVE.includes(one.status)) continue
    const known = seen.get(one.id)
    if (known) {
      known.item ??= one.item ?? null
      continue
    }
    const row = { id: one.id, status: one.status, kind: one.kind ?? null, item: one.item ?? null, reason: one.reason ?? '', label: targetLabel(one) }
    seen.set(one.id, row)
    out.push(row)
  }
  return out
}

/** What an item owes once its work is done (its pull request), not while it
    runs: Claude Code stops at the end of every turn (FERR-47). */
const END_OF_WORK = ['link_pr', 'summary_comment']

/** The obligations a turn's Stop asks about: all but the end-of-work ones of
    the item still leased, in time. A released item's still count (FERR-26). */
export function stopObligations(open, lease, leaseUntil, now) {
  const until = leaseUntil ? Date.parse(leaseUntil) : NaN
  const held = lease && Number.isFinite(until) && until > now ? lease : null
  return open.filter(one => !(held && one.item === held && END_OF_WORK.includes(one.kind)))
}

export function readOf(row) {
  if (!row || row.reason !== READ_INVALIDATED) return null
  const p = row.payload ?? {}
  if (typeof p.page_id !== 'string' || typeof p.block_id !== 'string') return null
  return {
    page: p.page_id,
    block: p.block_id,
    title: typeof row.title === 'string' && row.title ? row.title : p.page_id,
    excerpt: typeof p.excerpt === 'string' ? p.excerpt.replace(/\s+/g, ' ').trim() : '',
    old: typeof p.old_hash === 'string' ? p.old_hash : null,
    new: typeof p.new_hash === 'string' ? p.new_hash : null,
  }
}

export function slimRow(row) {
  const slim = { id: row.id, item: row.item ?? null, reason: row.reason, kind: row.kind, trust: row.trust ?? null }
  const read = readOf(row)
  if (read) slim.read = read
  return slim
}

const version = hash => (hash ? `v${hash.slice(0, 8)}` : 'removed')

export function readPrompt(rows) {
  return rows
    .filter(row => row.read)
    .map(
      ({ id, read: r }) =>
        `Ferrow: page ${r.page} › block ${r.block} changed since you read it (${version(r.old)}→${version(r.new)}); re-read it with wiki_page_get and confirm with wiki_confirm_block if your work still holds, or inbox_ack notification ${id} if the block is gone or you no longer rely on it.`,
    )
    .join('\n')
}

export function leaseMinutes(until, now) {
  const end = Date.parse(until ?? '')
  if (!Number.isFinite(end) || !Number.isFinite(now)) return null
  return Math.max(0, Math.round((end - now) / 60000))
}

const width = button => button.hotkey.length + 2 + button.label.length

/** The reasons a repo names its workspace itself (lib/credentials.sh). */
const DECLARED = ['env', 'ferrow.toml', 'binding']

/**
 * The band's one line while the plugin has no token (§17.5): the code to
 * approve while `/ferrow:connect` waits, else how to connect — to the
 * workspace the repo names, or which one, when several are on file and the
 * repo names none. Null once connected, when `bandModel` takes over.
 */
export function connectLine(state, lang, columns) {
  const w = words(lang)
  if (state.connecting) return fit(`ferrow · ${w.connecting(state.connecting.code, state.connecting.url)}`, columns)
  if (state.connected) return null
  if (state.reason === 'several') {
    return fit(`ferrow · ${w.notConnected} · ${w.several(state.known ?? [])} · /ferrow:connect <workspace>`, columns)
  }
  if (state.workspace && DECLARED.includes(state.reason)) {
    return fit(`ferrow · ${w.notConnectedTo(state.workspace)} · /ferrow:connect`, columns)
  }
  return fit(`ferrow · ${w.notConnected} · /ferrow:connect`, columns)
}

export function bandModel(state, lang, columns) {
  if (!state.session) return null
  const w = words(lang)
  const obligations = state.obligations ?? []
  const inbox = state.inbox ?? []
  const pending = state.pending ?? []
  const buttons = []
  if (obligations.length > 0) buttons.push({ key: 'obligations', hotkey: '1', label: w.buttons.obligations })
  if (inbox.length > 0) buttons.push({ key: 'inbox', hotkey: '2', label: w.buttons.inbox })
  if (pending.length > 0) buttons.push({ key: 'start', hotkey: 'b', label: w.buttons.start })
  buttons.push({ key: 'wake', hotkey: 'w', label: w.buttons.wake })

  const room = Math.max(0, columns - buttons.reduce((sum, b) => sum + width(b) + 2, 0))
  const rest = []
  if (inbox.length > 0) rest.push(w.inbox(inbox.length))
  if (state.lease) {
    const minutes = leaseMinutes(state.leaseUntil, state.now)
    rest.push(minutes === null ? state.lease : `${state.lease} · ${w.minutes(minutes)}`)
  }
  rest.push(w.wake[state.wake] ?? w.wake.ask)
  let line = ['ferrow', ...rest].join(' · ')
  if (obligations.length > 0) {
    const head = `ferrow · ${w.obligations(obligations.length)} · `
    const tail = ` · ${rest.join(' · ')}`
    const label = fit(obligations[0].label, room - head.length - tail.length)
    line = label ? `${head}${label}${tail}` : `ferrow · ${w.obligations(obligations.length)}${tail}`
  }

  const reads = inbox.filter(row => row.read)
  let read = null
  if (reads.length > 0) {
    const reload = { key: 'reload', hotkey: 'r', label: w.buttons.reload }
    const first = reads[0].read
    const label = first.excerpt ? `${first.title} › ${first.excerpt}` : first.title
    const room2 = Math.max(0, columns - width(reload) - 2)
    read = { count: reads.length, line: fit(`${w.changed(reads.length)} · ${label}`, room2), buttons: [reload] }
  }

  const flags = state.watch?.flags?.length ?? 0
  const confirms = state.watch?.confirms?.length ?? 0
  let watch = null
  if (flags + confirms > 0) {
    const apply = { key: 'apply', hotkey: 'f', label: w.buttons.apply }
    const text = `${w.watchman}: ${w.watch(flags, confirms)}`
    watch = { line: fit(text, Math.max(0, columns - width(apply) - 2)), buttons: [apply] }
  }

  const loose = state.unmapped?.length ?? 0
  let unmapped = null
  if (loose > 0) {
    const suggest = { key: 'suggest', hotkey: 'm', label: w.buttons.suggest }
    unmapped = { line: fit(w.unmapped(loose), Math.max(0, columns - width(suggest) - 2)), buttons: [suggest] }
  }
  return { line: fit(line, room), buttons, read, watch, unmapped }
}

const flat = text => String(text ?? '').replace(/\s+/g, ' ').trim()
const EXCERPT_MAX = 80

function candidateLine(c, w) {
  const where = c.block ? `${c.title} › ${c.block}` : `${c.title} (${w.map.title})`
  const excerpt = flat(c.excerpt)
  const said = excerpt ? ` · "${fit(excerpt, EXCERPT_MAX)}"` : ''
  return `${where}${said} · ${c.score}`
}

/**
 * The suggestions for unmapped files, then a `[[map]]` entry per file with
 * a suggestion, built from its best one. `rows` is the suggest route's
 * answer (`[{path, candidates}]`).
 */
export function suggestLines(rows, lang) {
  const w = words(lang)
  const lines = [w.map.suggestions]
  const blocks = []
  for (const row of rows ?? []) {
    lines.push(row.path)
    const candidates = row.candidates ?? []
    if (candidates.length === 0) lines.push(`  ${w.map.none}`)
    candidates.forEach((c, i) => lines.push(`  ${i + 1}. ${candidateLine(c, w)}`))
    if (candidates[0]) blocks.push(pasteBlock(row.path, candidates[0]))
  }
  if (blocks.length > 0) lines.push('', w.map.paste, '', ...blocks.join('\n\n').split('\n'))
  return lines
}

/**
 * The entries whose page does not exist, each with the command that creates
 * it under the entry's exact title. `checked` is the check route's answer.
 */
export function unknownLines(entries, checked, lang) {
  const w = words(lang)
  return (checked?.entries ?? [])
    .filter(row => row.status === 'page_unknown' && entries[row.entry - 1])
    .map(row => `"${entries[row.entry - 1].page.trim()}" (${w.map.unknown}) · ${w.map.create(row.entry)}`)
}

function entryLabel(entry, checked, w) {
  const named = entry.block ? `${entry.page} › ${entry.block}` : entry.page
  if (!checked) return named
  const title = checked.title ?? entry.page
  if (checked.status === 'ok') return entry.block ? `${title} › ${entry.block}` : title
  if (checked.status === 'page_unknown') return `"${entry.page}" (${w.map.unknown})`
  if (checked.status === 'page_ambiguous') return `"${entry.page}" (${w.map.ambiguous})`
  if (checked.status === 'block_unknown') return `${title} › ${entry.block} (${w.map.blockUnknown})`
  if (checked.status === 'duplicate') return `${entry.block ? `${title} › ${entry.block}` : title} (${w.map.duplicate(checked.duplicate_of)})`
  return named
}

/**
 * `/ferrow:map`'s text: the map's file and each entry resolved (titles from
 * the server's check when it answered), the edited files the map leaves
 * out, and the suggestions for them.
 */
export function mapReport(report, lang) {
  const w = words(lang)
  if (!report.file) return [w.map.noMap(report.cwd)].join('\n')
  const lines = [`ferrow.toml  ${report.file}`]
  if (report.error) {
    lines.push(report.error)
    return lines.join('\n')
  }
  const checked = report.checked?.entries ?? null
  report.entries.forEach((entry, n) => {
    const row = checked?.find(one => one.entry === n + 1)
    lines.push(`${n + 1}. ${entry.paths.join(', ')} → ${entryLabel(entry, row, w)}`)
    if (row?.status === 'page_unknown') lines.push(`   ${w.map.create(n + 1)}`)
  })
  if (!report.checked) lines.push(`(${w.map.offline})`)
  const loose = report.unmapped ?? []
  if (loose.length === 0) {
    lines.push(w.map.allMapped)
    return lines.join('\n')
  }
  for (const path of loose) lines.push(w.map.unmappedOne(path))
  if (report.suggestions) lines.push('', ...suggestLines(report.suggestions, lang))
  return lines.join('\n')
}

export const WATCH_PROMPT = [
  'Review this turn against the Ferrow context: which claims in the pack\'s ⚠/? blocks did the work rely on,',
  'and did any page block become wrong because of this turn?',
  'Answer as JSON {"flags":[{"page","block","reason"}],"confirms":[{"page","block"}]} and nothing else:',
  'page is the page id, block the block id as the pack names them; a confirm only for a block whose claim',
  'this turn checked against the code or the data; empty lists when nothing applies. Do not call tools.',
].join(' ')

const WATCH_MAX = 20
const REASON_MAX = 200
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/

const idOf = value => (typeof value === 'string' && ID.test(value.trim()) ? value.trim() : null)
const keyOf = one => `${one.page}\u0000${one.block}`

function entries(list, reasoned) {
  if (!Array.isArray(list)) return []
  const out = []
  for (const one of list) {
    const page = idOf(one?.page)
    const block = idOf(one?.block)
    if (!page || !block) continue
    if (!reasoned) {
      out.push({ page, block })
      continue
    }
    const reason = typeof one.reason === 'string' ? one.reason.replace(/\s+/g, ' ').trim().slice(0, REASON_MAX) : ''
    if (reason) out.push({ page, block, reason })
  }
  return out
}

export function parseWatch(text) {
  const s = String(text ?? '')
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let body
  try {
    body = JSON.parse(s.slice(start, end + 1))
  } catch {
    return null
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  if (!Array.isArray(body.flags) && !Array.isArray(body.confirms)) return null
  return mergeWatch(null, { flags: entries(body.flags, true), confirms: entries(body.confirms, false) })
}

export function mergeWatch(queue, found) {
  const flags = new Map()
  for (const one of [...(queue?.flags ?? []), ...(found?.flags ?? [])]) {
    flags.delete(keyOf(one))
    flags.set(keyOf(one), one)
  }
  const confirms = new Map()
  for (const one of [...(queue?.confirms ?? []), ...(found?.confirms ?? [])]) {
    if (flags.has(keyOf(one))) continue
    confirms.delete(keyOf(one))
    confirms.set(keyOf(one), one)
  }
  return { flags: [...flags.values()].slice(-WATCH_MAX), confirms: [...confirms.values()].slice(-WATCH_MAX) }
}

export function applyPrompt(queue) {
  const q = JSON.stringify
  const lines = [
    ...(queue?.flags ?? []).map(f => `- wiki_flag_stale(page: ${q(f.page)}, block: ${q(f.block)}, reason: ${q(f.reason)})`),
    ...(queue?.confirms ?? []).map(c => `- wiki_confirm_block(page: ${q(c.page)}, block: ${q(c.block)}, note: "watchman")`),
  ]
  if (lines.length === 0) return null
  return [
    'Ferrow watchman: the person asked you to record what the review of the last turns found. Make these calls, then go on:',
    ...lines,
    'Skip a call you know is wrong and say why in one line.',
  ].join('\n')
}

export const BRIEF_MAX = 8000
export const PROTOCOL =
  'Protocol: session_begin, item_claim, context_pack before you plan; a real choice the item leaves open: decision_propose, state your assumption, go on, never ask in the terminal; work done, checks green and nothing left to decide: commit by the repo conventions without asking; a repo connected to Ferrow (the daemon says so, or the item has a link_pr obligation): push ferrow/<KEY> and pr_open, never merge or move the item to completed; confirm or flag the ⚠/? blocks you rely on; a summary comment; answer every obligation (obligation_satisfy, or obligation_waive with a reason) before you stop; item_release.'

export function briefing(state) {
  const head = ['Ferrow context for this turn (the Ferrow mod; it changes as the work does):', PROTOCOL]
  if (!state.session) return [...head, 'No Ferrow session yet: call session_begin first.'].join('\n')
  const pack = state.pack?.item === state.lease ? state.pack?.asOf : null
  const lease = state.lease
    ? `Leased: ${state.lease}${pack ? ` · context_pack as_of ${pack}` : ' · no context_pack read yet'}${state.leaseUntil ? ` · lease until ${state.leaseUntil}` : ''}`
    : 'Leased: none'
  const body = [lease]
  const obligations = state.obligations ?? []
  const reads = (state.inbox ?? []).filter(row => row.read)
  const items = [
    ...obligations.map(o => `- obligation ${o.id} (${o.status}): ${o.reason.replace(/\s+/g, ' ').trim()}`),
    ...reads.map(row => `- ${readPrompt([row]).replace(/^Ferrow: /, '')}`),
  ]
  body.push(
    obligations.length ? `Open obligations: ${obligations.length}.` : 'Open obligations: none.',
    reads.length ? `Changed blocks you read: ${reads.length}.` : 'Changed blocks you read: none.',
  )
  const lines = [...head, ...body]
  let size = lines.join('\n').length
  let shown = 0
  for (const item of items) {
    const more = `+${items.length - shown} more (obligations_list, session_reads_list)`
    if (size + item.length + 1 + more.length + 1 > BRIEF_MAX) {
      lines.push(more)
      return lines.join('\n')
    }
    lines.push(item)
    size += item.length + 1
    shown += 1
  }
  return lines.join('\n')
}

export function packAsOf(text) {
  const match = /`[^`]*\bitem=(\S+)[^`]*\bas_of=(\S+)[^`]*`/.exec(String(text ?? ''))
  return match ? { item: match[1], asOf: match[2] } : null
}

const PRICES = [
  ['claude-fable-5-1', 10, 50, 12.5, 0.25],
  ['claude-mythos-5-1', 10, 50, 12.5, 0.25],
  ['claude-fable-5', 10, 50, 12.5, 1],
  ['claude-opus-5-5', 4, 20, 5, 0.2],
  ['claude-opus-5', 5, 25, 6.25, 0.5],
  ['claude-opus-4-8', 5, 25, 6.25, 0.5],
  ['claude-opus-4-7', 5, 25, 6.25, 0.5],
  ['claude-opus-4-6', 5, 25, 6.25, 0.5],
  ['claude-sonnet-5-5', 2, 10, 2.5, 0.2],
  ['claude-sonnet-5', 2, 10, 2.5, 0.2],
  ['claude-sonnet-4-6', 3, 15, 3.75, 0.3],
  ['claude-haiku-5-5', 0.1, 0.5, 0.125, 0.01],
  ['claude-haiku-4-5', 1, 5, 1.25, 0.1],
]

export function priceOf(model) {
  const id = String(model ?? '').toLowerCase().replace(/^.*?(claude-)/, '$1')
  const found = PRICES.filter(([prefix]) => id === prefix || id.startsWith(`${prefix}-`) || id.startsWith(`${prefix}[`))
    .sort((a, b) => b[0].length - a[0].length)[0]
  if (!found) return null
  const [, input, output, cacheWrite, cacheRead] = found
  return { input, output, cacheWrite, cacheRead }
}

export const NO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, micros: 0, priceUnknown: false, turns: 0 }

export function addUsage(total, usage) {
  if (!usage) return total
  const t = { ...NO_USAGE, ...total }
  const input = usage.input_tokens ?? 0
  const output = usage.output_tokens ?? 0
  const cacheRead = usage.cache_read_input_tokens ?? 0
  const cacheWrite = usage.cache_creation_input_tokens ?? 0
  const price = priceOf(usage.model)
  const micros = price
    ? input * price.input + output * price.output + cacheRead * price.cacheRead + cacheWrite * price.cacheWrite
    : 0
  return {
    ...t,
    input: t.input + input,
    output: t.output + output,
    cacheRead: t.cacheRead + cacheRead,
    cacheWrite: t.cacheWrite + cacheWrite,
    micros: t.micros + micros,
    priceUnknown: t.priceUnknown || !price,
    ...(typeof usage.model === 'string' ? { model: usage.model } : {}),
  }
}

export function sessionUsage(total) {
  const t = { ...NO_USAGE, ...total }
  const body = { tokens_in: t.input + t.cacheRead + t.cacheWrite, tokens_out: t.output }
  if (!t.priceUnknown) body.cost_cents = Math.round(t.micros / 10000)
  return body
}

export function usageReport(total, sent) {
  const now = sessionUsage(total)
  const before = { tokens_in: 0, tokens_out: 0, cost_cents: 0, ...sent }
  const body = { tokens_in: now.tokens_in - before.tokens_in, tokens_out: now.tokens_out - before.tokens_out }
  if (now.cost_cents !== undefined) body.cost_cents = Math.max(0, now.cost_cents - before.cost_cents)
  if (total?.model) body.model = total.model
  if (total?.turns) body.turn = total.turns
  return { body, sent: { ...now, cost_cents: now.cost_cents ?? before.cost_cents } }
}

function count(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`
  return String(n)
}

export function usageLine(total) {
  const t = { ...NO_USAGE, ...total }
  if (t.input + t.output + t.cacheRead + t.cacheWrite === 0) return null
  const tokens = `${count(t.input + t.cacheRead + t.cacheWrite)} in / ${count(t.output)} out`
  if (t.priceUnknown) return `${tokens} · price unknown`
  return `${tokens} · $${(t.micros / 1e6).toFixed(2)}`
}

export function obligationsList(obligations, lang) {
  if (obligations.length === 0) return lang === 'tr' ? 'Açık yükümlülük yok.' : 'No open obligations.'
  return obligations
    .map((o, i) => `${i + 1}. ${o.label} · ${o.status} · ${o.id}\n   ${o.reason}`)
    .join('\n')
}

export function inboxList(rows, lang) {
  if (rows.length === 0) return lang === 'tr' ? 'Inbox boş.' : 'The inbox is empty.'
  return rows
    .map((row, i) => `${i + 1}. ${[row.item ?? row.kind, row.reason, row.trust].filter(Boolean).join(' · ')} · ${row.id}`)
    .join('\n')
}
