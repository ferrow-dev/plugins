import { isMapped, MAP_FILE, parseRepoMap, pathMatches } from '../lib/repo-map-core.mjs'
import {
  addUsage,
  applyPrompt,
  bandModel,
  briefing,
  connectLine,
  inboxList,
  liveObligations,
  stopObligations,
  mapReport,
  mergeWatch,
  NO_USAGE,
  obligationsList,
  packAsOf,
  parseWatch,
  readPrompt,
  sessionUsage,
  slimRow,
  suggestLines,
  unknownLines,
  usageLine,
  usageReport,
  WATCH_PROMPT,
  words,
} from './band.js'

const SESSION = { plugin: 'ferrow', key: 'session' }
const LEASE = { plugin: 'ferrow', key: 'lease' }
const LEASE_UNTIL = { plugin: 'ferrow', key: 'leaseUntil' }
const CLAIMED = { plugin: 'ferrow', key: 'claimed' }
const INBOX = { plugin: 'ferrow', key: 'inbox' }
const PENDING = { plugin: 'ferrow', key: 'pending' }
const OBLIGATIONS = { plugin: 'ferrow', key: 'obligations' }
const CHECKED = { plugin: 'ferrow', key: 'checked' }
const WAKE = { plugin: 'ferrow', key: 'wake' }
const VIEW = { plugin: 'ferrow', key: 'view' }
const USAGE = { plugin: 'ferrow', key: 'usage' }
const REPORTED = { plugin: 'ferrow', key: 'reported' }
const WORKSPACE = { plugin: 'ferrow', key: 'workspace' }
const TOUCHED = { plugin: 'ferrow', key: 'touched' }
const NOTIFIED = { plugin: 'ferrow', key: 'notified' }
const BUSY = { plugin: 'ferrow', key: 'busy' }
const WATCH = { plugin: 'ferrow', key: 'watch' }
const WATCH_USAGE = { plugin: 'ferrow', key: 'watchUsage' }
const WATCH_ERROR = { plugin: 'ferrow', key: 'watchError' }
const TURN = { plugin: 'ferrow', key: 'turn' }
const FORKED = { plugin: 'ferrow', key: 'forked' }
const PACK = { plugin: 'ferrow', key: 'pack' }
const BRIEFED = { plugin: 'ferrow', key: 'briefed' }
const UNMAPPED = { plugin: 'ferrow', key: 'unmapped' }
const SUGGESTIONS = { plugin: 'ferrow', key: 'suggestions' }
const CONNECTING = { plugin: 'ferrow', key: 'connecting' }

const FERROW_TOOL = /^mcp__(plugin_ferrow_)?ferrow__/
export const TAKES_SESSION = [
  'context_pack',
  'decision_propose',
  'graph_link',
  'inbox_next',
  'inbox_wait',
  'item_claim',
  'item_release',
  'micro_question_propose',
  'obligations_list',
  'session_reads_list',
  'wiki_confirm_block',
  'wiki_flag_stale',
  'wiki_page_get',
  'wiki_page_write',
  'wiki_suggest',
  'wiki_suggestions_list',
]
const WAKES = ['on', 'ask', 'off']
const WATCHMEN = ['on', 'off']
const EVIDENCE = ['wiki_flag_stale', 'wiki_confirm_block']
const MAP_DEPTH = 40
const DEFAULT_URL = 'https://app.ferrow.dev'
const PANE = 'ferrow'
const POLL_MS = 5000
const OBLIGATIONS_MS = 30000
const WAIT_S = 25
const KEEP = 200
const CLAIMED_MAX = 10
const PACK_LINES = 40
const MIN_WAIVE = 10
const REPORT_TURNS = 10
const NOT_CONNECTED = 'not connected (/ferrow:connect)'

export function toolName(tool) {
  return String(tool).replace(FERROW_TOOL, '')
}

function field(r, name, pattern) {
  const found = [r?.result?.structuredContent, r?.result]
    .map(value => value?.[name])
    .find(value => typeof value === 'string')
  if (found) return found
  const match = new RegExp(`"${name}"\\s*:\\s*"(${pattern})"`).exec(r?.text ?? '')
  return match ? match[1] : null
}

export function sessionIdOf(r) {
  return field(r, 'session_id', '[0-9a-fA-F-]{36}')
}

export function itemOf(r) {
  return field(r, 'item', '[^"]+')
}

export function leaseUntilOf(r) {
  const lease = r?.result?.structuredContent?.lease ?? r?.result?.lease
  if (typeof lease?.expires_at === 'string') return lease.expires_at
  const match = /"expires_at"\s*:\s*"([^"]+)"/.exec(r?.text ?? '')
  return match ? match[1] : null
}

export function inboxPrompt(rows) {
  const list = rows
    .map(row => [row.item ?? row.entity_type ?? row.kind, row.reason, row.trust].filter(Boolean).join(' · '))
    .join('; ')
  const noun = rows.length === 1 ? 'notification' : 'notifications'
  return `Ferrow inbox: ${rows.length} new ${noun} (${list}). Take each with inbox_next, handle it as the Ferrow skill says, then inbox_ack it.`
}

export function statusLine(session, inbox, lease, obligations = 0, usage = null) {
  const parts = [`ferrow: ${session.slice(0, 8)}`, `inbox ${inbox}`, `lease ${lease ?? 'none'}`]
  if (obligations > 0) parts.push(`${obligations} open ${obligations === 1 ? 'obligation' : 'obligations'}`)
  if (usage) parts.push(usage)
  return parts.join(' · ')
}

export function gateReason(obligations) {
  const lines = obligations.map(o => `- ${o.reason} · obligation_id ${o.id}`)
  return [
    `The person asked you to answer ${obligations.length} open Ferrow ${obligations.length === 1 ? 'obligation' : 'obligations'} before stopping:`,
    ...lines,
    'Do what each asks, then obligation_satisfy(obligation_id); or obligation_waive(obligation_id, reason).',
  ].join('\n')
}

const ok = r => r.deny === undefined && r.isError !== true

const mod = {
  url: DEFAULT_URL,
  token: undefined,
  /** Where the token came from: `file` (the credentials file), `env`, or null. */
  source: null,
  /** `<agent> · <workspace>`, from the credentials file. */
  agent: null,
  /** The workspace this session's repo works in, and why (bin/ferrow-workspace). */
  workspace: null,
  reason: null,
  /** The workspaces with a token on file. */
  known: [],
  interactive: false,
  /** The running `/ferrow:connect`: resolves to its code, or why it failed. */
  connecting: null,
  wake: 'ask',
  watchman: 'off',
  lang: 'en',
  loop: null,
  checker: null,
  polling: false,
  refreshing: false,
  lastCheck: 0,
  usage: Promise.resolve(),
  watching: Promise.resolve(),
  takes: new Set(TAKES_SESSION),
}

export function sessionTools(list) {
  const tools = list?.result?.tools
  if (!Array.isArray(tools)) return null
  return new Set(
    tools
      .filter(tool => typeof tool?.name === 'string' && Object.hasOwn(tool.inputSchema?.properties ?? {}, 'session'))
      .map(tool => tool.name),
  )
}

function headers(session, json = false) {
  const out = { Authorization: `Bearer ${mod.token}`, 'X-Ferrow-Client': 'claude_code' }
  if (session) out['X-Ferrow-Session'] = session
  if (json) out['Content-Type'] = 'application/json'
  return out
}

async function wakeMode($) {
  const stored = await $.store.get('wake')
  return WAKES.includes(stored) ? stored : mod.wake
}

async function watchmanMode($) {
  const stored = await $.store.get('watchman')
  return WATCHMEN.includes(stored) ? stored : mod.watchman
}

function errorOf(res) {
  try {
    const body = JSON.parse(res.text)
    return body?.error?.code ?? body?.code ?? body?.error ?? `http_${res.status}`
  } catch {
    return `http_${res.status}`
  }
}

async function mcp($, name, args) {
  const session = (await $.state.get(SESSION)).value ?? null
  const res = await $.http.fetch(`${mod.url}/mcp/agent`, {
    method: 'POST',
    headers: { ...headers(session, true), Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  })
  if (!res.ok) throw new Error(errorOf(res))
  const body = JSON.parse(res.text)
  const text = body?.result?.content?.[0]?.text ?? ''
  if (body.error || body.result?.isError) throw new Error(body.error?.message ?? text)
  let json = body.result?.structuredContent
  if (json === undefined) {
    try {
      json = JSON.parse(text)
    } catch {
      json = null
    }
  }
  return { text, json }
}

async function loadTools($) {
  if (!mod.token) return
  const res = await $.http.fetch(`${mod.url}/mcp/agent`, {
    method: 'POST',
    headers: { ...headers(null, true), Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  })
  if (!res.ok) return
  const found = sessionTools(JSON.parse(res.text))
  if (found) mod.takes = found
}

async function rest($, method, path, body) {
  const res = await $.http.fetch(`${mod.url}${path}`, {
    method,
    headers: headers(null, body !== undefined),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!res.ok) throw new Error(errorOf(res))
  return res.text ? JSON.parse(res.text) : null
}

async function workspace($) {
  const known = (await $.state.get(WORKSPACE)).value ?? null
  if (known) return known
  const { json } = await mcp($, 'workspace_list', {})
  const slug = Array.isArray(json) ? json[0]?.slug : null
  if (typeof slug !== 'string') throw new Error('no_workspace')
  await $.state.set(WORKSPACE, slug)
  return slug
}

/** The items this session claimed, the leased one included: a released
    item's `link_pr` is still owed (FERR-26). */
async function claimedItems($) {
  const lease = (await $.state.get(LEASE)).value ?? null
  const claimed = (await $.state.get(CLAIMED)).value ?? []
  return lease && !claimed.includes(lease) ? [...claimed, lease] : claimed
}

async function refreshObligations($, force) {
  if (!mod.token || mod.refreshing) return
  const now = await $.clock.now()
  if (!force && now - mod.lastCheck < OBLIGATIONS_MS) return
  mod.refreshing = true
  try {
    const session = (await $.state.get(SESSION)).value ?? null
    if (!session) return
    const lists = [(await mcp($, 'obligations_list', { session })).json?.obligations ?? []]
    for (const item of await claimedItems($)) {
      const rows = (await mcp($, 'obligations_list', { item, session })).json?.obligations ?? []
      lists.push(rows.map(one => ({ ...one, item })))
    }
    await $.state.set(OBLIGATIONS, liveObligations(lists))
    mod.lastCheck = now
    await $.state.set(CHECKED, now)
  } finally {
    mod.refreshing = false
  }
}

function startLoop($) {
  if (mod.loop || !mod.token) return
  mod.loop = $.clock.every(POLL_MS, () => {
    poll($).catch(() => {})
  })
}

function stopLoop() {
  if (mod.loop) mod.loop.cancel()
  mod.loop = null
}

function startChecker($) {
  if (mod.checker || !mod.token) return
  mod.checker = $.clock.every(OBLIGATIONS_MS, () => {
    refreshObligations($, false).catch(() => {})
  })
}

function stopChecker() {
  if (mod.checker) mod.checker.cancel()
  mod.checker = null
}

async function setRows($, rows) {
  await $.state.set(INBOX, rows)
  const ids = rows.map(row => row.id)
  const pending = (await $.state.get(PENDING)).value ?? []
  const left = pending.filter(id => ids.includes(id))
  if (left.length !== pending.length) await $.state.set(PENDING, left)
}

async function poll($) {
  if (mod.polling) return
  mod.polling = true
  try {
    const session = (await $.state.get(SESSION)).value ?? null
    if (!session) return
    const query = `wait=${WAIT_S}&session=${encodeURIComponent(session)}`
    const res = await $.http.fetch(`${mod.url}/agent/inbox?${query}`, { headers: headers() })
    if (!res.ok) return
    const rows = (JSON.parse(res.text).notifications ?? []).map(slimRow)
    await setRows($, rows)
    const seen = (await $.state.get(NOTIFIED)).value ?? []
    const fresh = rows.filter(row => !seen.includes(row.id) && !row.read)
    if (fresh.length === 0) return
    const mode = await wakeMode($)
    if (mode === 'off') return
    if ((await $.state.get(BUSY)).value) return
    await $.state.set(NOTIFIED, [...seen, ...fresh.map(row => row.id)].slice(-KEEP))
    if (mode === 'ask') {
      const pending = (await $.state.get(PENDING)).value ?? []
      await $.state.set(PENDING, [...pending, ...fresh.map(row => row.id)])
      $.ui.toast(mod.lang === 'tr' ? `Ferrow: ${fresh.length} yeni bildirim · b: başla` : `Ferrow: ${fresh.length} new · b: start`)
      return
    }
    await $.prompt.submit({ text: inboxPrompt(fresh) })
  } finally {
    mod.polling = false
  }
}

async function startPending($) {
  const pending = (await $.state.get(PENDING)).value ?? []
  const rows = ((await $.state.get(INBOX)).value ?? []).filter(row => pending.includes(row.id))
  await $.state.set(PENDING, [])
  if (rows.length > 0) await $.prompt.submit({ text: inboxPrompt(rows) })
}

async function setWake($, mode) {
  await $.store.set('wake', mode)
  await $.state.set(WAKE, mode)
  if (mode === 'off') stopLoop()
  else startLoop($)
}

async function cycleWake($) {
  const now = await wakeMode($)
  const next = { ask: 'on', on: 'off', off: 'ask' }[now]
  await setWake($, next)
  $.ui.toast(`ferrow: ${words(mod.lang).wake[next]}`)
}

async function openPane($, view) {
  await $.state.set(VIEW, view)
  await $.ui.open({ id: PANE, title: 'Ferrow' })
}

async function reload($) {
  if ((await wakeMode($)) === 'off' || (await $.state.get(BUSY)).value) return
  const rows = ((await $.state.get(INBOX)).value ?? []).filter(row => row.read)
  if (rows.length > 0) await $.prompt.submit({ text: readPrompt(rows) })
}

async function applyWatch($) {
  if ((await $.state.get(BUSY)).value) return
  const text = applyPrompt((await $.state.get(WATCH)).value)
  if (!text) return
  await $.state.set(WATCH, null)
  await $.prompt.submit({ text })
}

async function press($, key) {
  if (key === 'obligations' || key === 'inbox') return openPane($, key)
  if (key === 'start') return startPending($)
  if (key === 'wake') return cycleWake($)
  if (key === 'reload') return reload($)
  if (key === 'apply') return applyWatch($)
  if (key === 'suggest') return suggestPane($)
}

function guarded($, key) {
  return () =>
    press($, key).catch(error => {
      $.ui.toast(`ferrow: ${error?.message ?? 'failed'}`)
    })
}

async function bandState($) {
  const inbox = (await $.state.get(INBOX)).value ?? []
  const pending = (await $.state.get(PENDING)).value ?? []
  return {
    session: (await $.state.get(SESSION)).value ?? null,
    obligations: (await $.state.get(OBLIGATIONS)).value ?? [],
    inbox,
    pending: inbox.filter(row => pending.includes(row.id)),
    lease: (await $.state.get(LEASE)).value ?? null,
    leaseUntil: (await $.state.get(LEASE_UNTIL)).value ?? null,
    now: (await $.state.get(CHECKED)).value ?? null,
    wake: (await $.state.get(WAKE)).value ?? mod.wake,
    watch: (await $.state.get(WATCH)).value ?? null,
    unmapped: (await $.state.get(UNMAPPED)).value ?? [],
  }
}

async function briefState($) {
  return {
    session: (await $.state.get(SESSION)).value ?? null,
    obligations: (await $.state.get(OBLIGATIONS)).value ?? [],
    inbox: (await $.state.get(INBOX)).value ?? [],
    lease: (await $.state.get(LEASE)).value ?? null,
    leaseUntil: (await $.state.get(LEASE_UNTIL)).value ?? null,
    pack: (await $.state.get(PACK)).value ?? null,
  }
}

const parentOf = path => path.slice(0, Math.max(0, path.lastIndexOf('/')))

async function mapped($, paths) {
  const cwd = await $.session.cwd()
  for (const raw of paths) {
    const path = raw.startsWith('/') ? raw : `${cwd}/${raw}`
    let dir = parentOf(path)
    for (let depth = 0; dir && depth < MAP_DEPTH; depth += 1) {
      if (await $.fs.exists(`${dir}/${MAP_FILE}`)) {
        const text = await $.fs.read(`${dir}/${MAP_FILE}`)
        const map = parseRepoMap(typeof text === 'string' ? text : '')
        const relative = path.slice(dir.length + 1)
        if (map.some(entry => entry.paths.some(pattern => pathMatches(pattern, relative)))) return true
        break
      }
      if (await $.fs.exists(`${dir}/.git`)) break
      dir = parentOf(dir)
    }
  }
  return false
}

async function touchedFerrow($, turn) {
  if (turn.ferrow) return true
  if (!turn.paths?.length) return false
  try {
    return await mapped($, turn.paths)
  } catch {
    return false
  }
}

async function absolute($, raw) {
  return raw.startsWith('/') ? raw : `${await $.session.cwd()}/${raw}`
}

async function mapAt($, path) {
  let dir = parentOf(path)
  for (let depth = 0; dir && depth < MAP_DEPTH; depth += 1) {
    const file = `${dir}/${MAP_FILE}`
    if (await $.fs.exists(file)) {
      const text = await $.fs.read(file)
      return { root: dir, file, text: typeof text === 'string' ? text : '' }
    }
    if (await $.fs.exists(`${dir}/.git`)) return null
    dir = parentOf(dir)
  }
  return null
}

function entriesOf(found) {
  try {
    return parseRepoMap(found.text)
  } catch {
    return null
  }
}

async function recheck($, list) {
  const maps = new Map()
  const left = []
  for (const one of list) {
    if (!maps.has(one.root)) maps.set(one.root, await mapAt($, `${one.root}/${MAP_FILE}`))
    const found = maps.get(one.root)
    const entries = found ? entriesOf(found) : null
    if (found && entries && isMapped(entries, one.path)) continue
    if (found) left.push(one)
  }
  return left
}

async function noteUnmapped($, raw) {
  const path = await absolute($, raw)
  const found = await mapAt($, path)
  if (!found) return
  const list = (await $.state.get(UNMAPPED)).value ?? []
  if (path === found.file) {
    await $.state.set(UNMAPPED, await recheck($, list))
    return
  }
  const entries = entriesOf(found)
  if (!entries) return
  const relative = path.slice(found.root.length + 1)
  const known = list.some(one => one.abs === path)
  if (isMapped(entries, relative)) {
    if (known) await $.state.set(UNMAPPED, list.filter(one => one.abs !== path))
  } else if (!known) {
    await $.state.set(UNMAPPED, [...list, { abs: path, path: relative, root: found.root }].slice(-KEEP))
  }
}

async function suggestionsFor($, list) {
  if (!mod.token) throw new Error(NOT_CONNECTED)
  const paths = encodeURIComponent(list.map(one => one.path).join(','))
  return rest($, 'GET', `/agent/repo-map/suggest?paths=${paths}`)
}

/** The map `/ferrow:map` and the pane read: the one above the cwd, else the one above the first unmapped file. */
async function sessionMap($, list) {
  const cwd = await $.session.cwd()
  return (await mapAt($, `${cwd}/${MAP_FILE}`)) ?? (list[0] ? await mapAt($, list[0].abs) : null)
}

const checkMap = ($, text) => (mod.token ? rest($, 'POST', '/agent/repo-map/check', { repo_map: text }).catch(() => null) : null)

async function suggestPane($) {
  const list = await recheck($, (await $.state.get(UNMAPPED)).value ?? [])
  await $.state.set(UNMAPPED, list)
  let rows = list.map(one => ({ path: one.path, candidates: [] }))
  let error = null
  if (list.length > 0) {
    try {
      rows = await suggestionsFor($, list)
    } catch (failure) {
      error = failure?.message ?? 'failed'
    }
  }
  const found = await sessionMap($, list)
  const entries = found ? entriesOf(found) : null
  const unknown = entries ? unknownLines(entries, await checkMap($, found.text), mod.lang) : []
  await $.state.set(SUGGESTIONS, { rows, error, unknown })
  await openPane($, 'map')
}

/** `/ferrow:map create N`: the page entry N names, created with its exact title when the server has none. */
async function createMapped($, list, n) {
  const w = words(mod.lang)
  if (!mod.token) return NOT_CONNECTED
  const found = await sessionMap($, list)
  const entries = found ? entriesOf(found) : null
  const entry = entries?.[n - 1]
  if (!entry) return w.map.noEntry(n)
  const title = entry.page.trim()
  const checked = await rest($, 'POST', '/agent/repo-map/check', { repo_map: found.text })
  const row = checked?.entries?.find(one => one.entry === n)
  if (row?.status !== 'page_unknown') return w.map.exists(row?.title ?? title)
  await mcp($, 'wiki_page_create', { workspace: await workspace($), title })
  return w.map.created(title)
}

async function watch($, turnId) {
  if (!mod.token || (await watchmanMode($)) !== 'on') return
  if (!(await $.state.get(SESSION)).value) return
  if ((await $.state.get(FORKED)).value === turnId) return
  const turn = (await $.state.get(TURN)).value ?? null
  if (!turn || turn.id !== turnId || !(await touchedFerrow($, turn))) return
  await $.state.set(FORKED, turnId)
  const r = await $.model.fork({ prompt: WATCH_PROMPT })
  if (r.usage) {
    const usage = { ...r.usage, model: await $.session.model() }
    mod.usage = mod.usage
      .then(async () => {
        await $.state.set(USAGE, addUsage((await $.state.get(USAGE)).value ?? NO_USAGE, usage))
        await $.state.set(WATCH_USAGE, addUsage((await $.state.get(WATCH_USAGE)).value ?? NO_USAGE, usage))
      })
      .catch(() => {})
    await mod.usage
  }
  if (!r.isAnswered) {
    await $.state.set(WATCH_ERROR, r.reason)
    return
  }
  const found = parseWatch(r.text)
  if (!found) {
    await $.state.set(WATCH_ERROR, 'unreadable')
    return
  }
  await $.state.set(WATCH_ERROR, null)
  if (found.flags.length + found.confirms.length === 0) return
  const left = await writeWatch($, found)
  if (left.flags.length + left.confirms.length === 0) return
  await $.state.set(WATCH, mergeWatch((await $.state.get(WATCH)).value, left))
}

async function postEvidence($, session, body) {
  try {
    const res = await $.http.fetch(`${mod.url}/agent/evidence`, {
      method: 'POST',
      headers: headers(session, true),
      body: JSON.stringify(body),
    })
    return res.ok
  } catch {
    return false
  }
}

async function writeWatch($, found) {
  const session = (await $.state.get(SESSION)).value ?? null
  const left = { flags: [], confirms: [] }
  for (const flag of found.flags) {
    const body = { kind: 'flag', page: flag.page, block: flag.block, reason: flag.reason }
    if (!(await postEvidence($, session, body))) left.flags.push(flag)
  }
  for (const confirm of found.confirms) {
    const body = { kind: 'confirm', page: confirm.page, block: confirm.block, note: 'watchman' }
    if (!(await postEvidence($, session, body))) left.confirms.push(confirm)
  }
  return left
}

async function waive($, obligations, reason) {
  const ws = await workspace($)
  for (const one of obligations) {
    await rest($, 'POST', `/api/v1/workspaces/${encodeURIComponent(ws)}/obligations/${one.id}/waive`, { reason }).catch(() => {})
  }
}

async function closeGate($, e, next) {
  if (!mod.token || !(await $.state.get(SESSION)).value) return next(e)
  await refreshObligations($, true).catch(() => {})
  const open = stopObligations(
    (await $.state.get(OBLIGATIONS)).value ?? [],
    (await $.state.get(LEASE)).value ?? null,
    (await $.state.get(LEASE_UNTIL)).value ?? null,
    await $.clock.now(),
  )
  if (open.length === 0) return next(e)
  const tr = mod.lang === 'tr'
  const choices = tr
    ? ['Yükümlülükleri karşıla', 'Gerekçeyle geç', 'Yine de dur']
    : ['Satisfy them', 'Waive with a reason', 'Stop anyway']
  const question = tr
    ? `${open.length} yükümlülük açık (${open[0].label}). Ne yapalım?`
    : `${open.length} open Ferrow ${open.length === 1 ? 'obligation' : 'obligations'} (${open[0].label}). What now?`
  let choice
  try {
    choice = await $.ui.ask(question, choices)
  } catch {
    return next(e)
  }
  if (choice === choices[0]) {
    const r = await next(e)
    return r.block ? r : { ...r, block: gateReason(open) }
  }
  if (choice === choices[2]) {
    const { block, ...passed } = await next(e)
    return passed
  }
  const reasons = tr
    ? ['Bu değişiklik sayfayı etkilemiyor', 'Sayfa zaten güncel']
    : ['This change does not affect the page', 'The page is already up to date']
  // Only the waive choice waives: text typed in place of a choice is the
  // person saying something else, often a question, never a reason (FERR-47).
  if (choice !== choices[1]) return next(e)
  let reason
  try {
    reason = await $.ui.ask(tr ? 'Neden gerekmiyor? (en az 10 karakter)' : 'Why is it not needed? (10 characters at least)', reasons)
  } catch {
    return next(e)
  }
  if (typeof reason !== 'string' || reason.trim().length < MIN_WAIVE) return next(e)
  await waive($, open, reason.trim())
  await refreshObligations($, true).catch(() => {})
  return next(e)
}

async function reportUsage($, session, total) {
  if (!mod.token) return
  const { body, sent } = usageReport(total, (await $.state.get(REPORTED)).value ?? undefined)
  await rest($, 'POST', `/agent/sessions/${encodeURIComponent(session)}/usage`, body)
  await $.state.set(REPORTED, sent)
}

async function endSession($) {
  const session = (await $.state.get(SESSION)).value ?? null
  if (!mod.token || !session) return
  const usage = sessionUsage((await $.state.get(USAGE)).value ?? NO_USAGE)
  await rest($, 'PATCH', `/agent/sessions/${encodeURIComponent(session)}`, { state: 'ended', ...usage })
  await $.state.set(SESSION, null)
  await $.state.set(USAGE, NO_USAGE)
  await $.state.set(REPORTED, null)
}

function watchStatus(queue, usage, error) {
  const parts = []
  const pending = (queue?.flags?.length ?? 0) + (queue?.confirms?.length ?? 0)
  if (pending > 0) parts.push(`${queue.flags.length} flag(s), ${queue.confirms.length} confirm(s) waiting (f)`)
  const spent = usageLine(usage ?? NO_USAGE)
  if (spent) parts.push(spent)
  if (error) parts.push(`last run: ${error}`)
  return parts.length ? ` · ${parts.join(' · ')}` : ''
}

function tokenLine() {
  if (mod.source === 'file') return `${mod.agent ?? 'agent'} (credentials file)`
  if (mod.source === 'env') return 'FERROW_AGENT_TOKEN'
  return notConnected()
}

const REASONS = {
  env: 'FERROW_WORKSPACE',
  'ferrow.toml': "the repo's ferrow.toml",
  binding: 'bound to this repo (/ferrow:connect)',
  only: 'the only one on file',
  none: 'nothing on file',
  several: 'several on file, and this repo names none',
}

function workspaceLine() {
  const why = REASONS[mod.reason] ?? mod.reason ?? 'unknown'
  return mod.workspace ? `${mod.workspace} (${why})` : `none (${why})`
}

/** Why there is no token, in the words the band uses. */
function notConnected() {
  return connectLine({ connected: false, reason: mod.reason, workspace: mod.workspace, known: mod.known }, mod.lang, 400)
    .replace(/^ferrow · /, '')
}

function packText(text) {
  const lines = String(text ?? '').split('\n')
  const head = lines.slice(0, PACK_LINES).join('\n')
  return lines.length > PACK_LINES ? `${head}\n… ${lines.length - PACK_LINES} more lines (context_pack)` : head
}

/** bin/ferrow-workspace's lines: `{workspace, reason, agent, envok, known, token}`. */
export function workspaceLines(stdout) {
  const found = { workspace: null, reason: null, agent: null, envok: false, known: [], token: null }
  for (const line of String(stdout ?? '').split('\n')) {
    const { word, rest } = loginLine(line)
    if (word === 'workspace' || word === 'agent') found[word] = rest && rest !== '-' ? rest : null
    else if (word === 'reason') found.reason = rest || null
    else if (word === 'envok') found.envok = rest === '1'
    else if (word === 'known') found.known = rest ? rest.split(' ') : []
    else if (word === 'token') found.token = rest || null
  }
  return found
}

/** The workspace this session's repo works in and its token (wiki §17.4).
    Resolved by bin/ferrow-workspace, the code the MCP helper and the hooks
    run too, so the three never pick different agents. A token from
    FERROW_AGENT_TOKEN only where that may stand in; when the script cannot
    run at all, as before there were workspaces. */
async function loadToken($) {
  const env = (await $.env.get('FERROW_AGENT_TOKEN')) || undefined
  let found
  try {
    const argv = ['sh', `${$.plugin.root}/bin/ferrow-workspace`, '--server', mod.url, '--cwd', await $.session.cwd(), '--token']
    const r = await $.process.run(argv, { timeoutMs: 10000 })
    found = r.exitCode === 0 ? workspaceLines(r.stdout) : null
    if (!found?.reason) found = null
  } catch {
    found = null
  }
  found ??= { workspace: null, reason: 'none', agent: null, envok: true, known: [], token: null }
  mod.workspace = found.workspace
  mod.reason = found.reason
  mod.known = found.known
  mod.token = found.token ?? (found.envok ? env : undefined)
  mod.source = found.token ? 'file' : mod.token ? 'env' : null
  mod.agent = found.token ? [found.agent, found.workspace].filter(Boolean).join(' · ') : null
}

async function login($, args) {
  return ['sh', `${$.plugin.root}/bin/ferrow-login`, '--porcelain', '--server', mod.url, '--cwd', await $.session.cwd(), ...args]
}

/** One `--porcelain` line of bin/ferrow-login: `url …`, `code …`, `connected …`, `error …`. */
export function loginLine(line) {
  const at = line.indexOf(' ')
  return at < 0 ? { word: line.trim(), rest: '' } : { word: line.slice(0, at), rest: line.slice(at + 1).trim() }
}

async function connected($, found) {
  await $.state.set(CONNECTING, null)
  if (found.connected === undefined) {
    $.ui.toast(`ferrow: ${found.error ?? 'connect failed'}`)
    return
  }
  await loadToken($)
  const linked = await $.mcp.connect('ferrow').catch(() => null)
  loadTools($).catch(() => {})
  if (mod.interactive) {
    if ((await wakeMode($)) !== 'off') startLoop($)
    startChecker($)
  }
  const hint = linked && !linked.isConnected ? ' · /mcp → ferrow → Reconnect' : ''
  $.ui.toast(`ferrow: ${mod.lang === 'tr' ? 'bağlandı' : 'connected'} · ${mod.agent ?? found.connected}${hint}`)
  for (const note of loginNotes(found, mod.lang)) $.ui.toast(`ferrow: ${note}`)
}

/** What bin/ferrow-login said besides `connected`: the binding it wrote,
    a workspace other than the hinted one, and the ferrow.toml line it offers. */
export function loginNotes(found, lang) {
  const tr = lang === 'tr'
  const notes = []
  if (found.differs) {
    const [hint, got] = found.differs.split(' ')
    notes.push(tr ? `bu repo ${hint} kullanıyor, ajan ${got} için onaylandı` : `this repo works in ${hint}, but the agent was approved in ${got}`)
  }
  if (found.bound) notes.push(tr ? `${found.bound} bu çalışma alanına bağlandı` : `bound ${found.bound} to this workspace`)
  if (found.offer) notes.push(tr ? `ekibin seçimi olsun diye ferrow.toml'un başına: ${found.offer}` : `to make it the team's choice, put ${found.offer} at the top of ferrow.toml`)
  return notes
}

/** Runs bin/ferrow-login, which files the token; resolves once the code is
    known (or the login failed), and finishes in the background. */
function connect($, target) {
  if (mod.connecting) return mod.connecting
  let ready
  mod.connecting = new Promise(resolve => (ready = resolve))
  const found = {}
  void (async () => {
    let buffer = ''
    try {
      for await (const piece of $.process.spawn({ argv: await login($, target ? ['--open', target] : ['--open']) })) {
        if (piece.stream !== 'stdout' || typeof piece.text !== 'string') continue
        buffer += piece.text
        let at
        while ((at = buffer.indexOf('\n')) >= 0) {
          const { word, rest } = loginLine(buffer.slice(0, at))
          buffer = buffer.slice(at + 1)
          found[word] = rest
          if (word === 'code' && found.url) {
            await $.state.set(CONNECTING, { code: rest, url: found.url })
            ready({ code: rest, url: found.url })
          }
        }
      }
    } catch (error) {
      found.error ??= error?.message ?? 'failed'
    }
    // Without a code: the workspace already had a token, and the repo is bound to it.
    ready(found.connected !== undefined ? { found } : { error: found.error ?? 'failed' })
    await connected($, found).catch(() => {})
    mod.connecting = null
  })()
  return mod.connecting
}

export function register(on, options = {}) {
  stopLoop()
  stopChecker()
  mod.polling = false
  mod.refreshing = false
  mod.lastCheck = 0
  mod.takes = new Set(TAKES_SESSION)
  mod.wake = WAKES.includes(options.wake) ? options.wake : 'ask'
  mod.watchman = WATCHMEN.includes(options.watchman) ? options.watchman : 'off'

  on('session.start', async ($, e, next) => {
    mod.url = ((await $.env.get('FERROW_URL')) || DEFAULT_URL).replace(/\/+$/, '')
    await loadToken($)
    mod.interactive = Boolean(e.isInteractive)
    mod.lang = ((await $.env.get('LANG')) ?? '').startsWith('tr') ? 'tr' : 'en'
    const mode = await wakeMode($)
    await $.state.set(WAKE, mode)
    loadTools($).catch(() => {})
    if (e.isInteractive) {
      if (mode !== 'off') startLoop($)
      startChecker($)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    await $.state.set(BUSY, true)
    await $.state.set(TURN, { id: e.turnId ?? null, ferrow: false, paths: [] })
    return next(e)
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    if (!mod.token) return next(e)
    const block = briefing(await briefState($))
    if ((await $.state.get(BRIEFED)).value === block) return next(e)
    await $.state.set(BRIEFED, block)
    return next({ ...e, context: [...(e.context ?? []), block] })
  }).catch(($, e, next) => next(e))

  on('session.compact', async ($, e, next) => {
    if (e.agentId === undefined) await $.state.set(BRIEFED, null)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    if (r?.usage) {
      mod.usage = mod.usage
        .then(async () => $.state.set(USAGE, addUsage((await $.state.get(USAGE)).value ?? NO_USAGE, r.usage)))
        .catch(() => {})
      await mod.usage
    }
    return r
  })

  on('tool.call', { tool: FERROW_TOOL }, async ($, e, next) => {
    const name = toolName(e.tool)
    let call = e
    if (name === 'session_begin') {
      call = { ...e, client: 'claude_code', wake_method: 'mod', client_session: await $.session.id() }
    } else if (mod.takes.has(name) && e.session === undefined) {
      const session = (await $.state.get(SESSION)).value ?? null
      if (session) call = { ...e, session }
    }
    const r = await next(call)
    if (!ok(r)) return r
    if (!EVIDENCE.includes(name)) {
      const turn = (await $.state.get(TURN)).value ?? null
      if (turn && !turn.ferrow) await $.state.set(TURN, { ...turn, ferrow: true })
    }
    if (name === 'session_begin') {
      const session = sessionIdOf(r)
      if (session) await $.state.set(SESSION, session)
    } else if (name === 'item_claim') {
      const item = itemOf(r) ?? call.item
      if (typeof item === 'string') {
        await $.state.set(LEASE, item)
        await $.state.set(LEASE_UNTIL, leaseUntilOf(r))
        const claimed = ((await $.state.get(CLAIMED)).value ?? []).filter(one => one !== item)
        await $.state.set(CLAIMED, [...claimed, item].slice(-CLAIMED_MAX))
        await $.state.set(CHECKED, await $.clock.now())
      }
    } else if (name === 'context_pack') {
      const pack = packAsOf(r?.text) ?? packAsOf(JSON.stringify(r?.result ?? null))
      if (pack) await $.state.set(PACK, pack)
    } else if (name === 'item_release') {
      const lease = (await $.state.get(LEASE)).value ?? null
      if (lease === (itemOf(r) ?? call.item)) {
        await $.state.set(LEASE, null)
        await $.state.set(LEASE_UNTIL, null)
      }
    }
    refreshObligations($, true).catch(() => {})
    return r
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: ['Edit', 'Write'] }, async ($, e, next) => {
    const path = e.file_path
    if (typeof path === 'string') {
      const touched = (await $.state.get(TOUCHED)).value ?? []
      if (!touched.includes(path)) await $.state.set(TOUCHED, [...touched, path].slice(-KEEP))
      const turn = (await $.state.get(TURN)).value ?? null
      if (turn && !turn.paths.includes(path)) await $.state.set(TURN, { ...turn, paths: [...turn.paths, path].slice(-KEEP) })
      await noteUnmapped($, path).catch(() => {})
    }
    const r = await next(e)
    refreshObligations($, true).catch(() => {})
    return r
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined) return r
    await $.state.set(BUSY, false)
    const session = (await $.state.get(SESSION)).value ?? null
    if (!session) return r
    if (!e.isAborted) mod.watching = watch($, e.turnId).catch(() => {})
    const counted = (await $.state.get(USAGE)).value ?? NO_USAGE
    const usage = { ...counted, turns: (counted.turns ?? 0) + 1 }
    await $.state.set(USAGE, usage)
    if (usage.turns % REPORT_TURNS === 0) reportUsage($, session, usage).catch(() => {})
    const inbox = ((await $.state.get(INBOX)).value ?? []).length
    const lease = (await $.state.get(LEASE)).value ?? null
    const obligations = ((await $.state.get(OBLIGATIONS)).value ?? []).length
    return { ...r, text: statusLine(session, inbox, lease, obligations, usageLine(usage)) }
  }).catch(($, e, next) => next(e))

  on('attribution.text', { kind: 'commit' }, async ($, e, next) => {
    const r = await next(e)
    const lease = (await $.state.get(LEASE)).value
    if (!lease) return r
    const trailer = `Ferrow: ${lease}`
    return { ...r, text: r.text ? `${r.text}\n${trailer}` : trailer }
  }).catch(($, e, next) => next(e))

  on('classic.Stop', closeGate).catch(($, e, next) => next(e))

  on('classic.SessionEnd', async ($, e, next) => {
    await endSession($).catch(() => {})
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const columns = e.props.bodyColumns ?? 80
    const connecting = (await $.state.get(CONNECTING)).value ?? null
    const single = connectLine(
      { connecting, connected: Boolean(mod.token), reason: mod.reason, workspace: mod.workspace, known: mod.known },
      mod.lang,
      columns,
    )
    const { Box, Text, Button } = $.ui.resolve(e)
    if (single) return Box({ flexDirection: 'row', children: [Text({ wrap: 'truncate', children: single })] })
    const model = bandModel(await bandState($), mod.lang, columns)
    if (!model) return next(e)
    const button = b => Button({ key: b.key, label: b.label, hotkey: b.hotkey, plain: true, onPress: guarded($, b.key) })
    const rows = [Box({ flexDirection: 'row', gap: 2, children: [Text({ wrap: 'truncate', children: model.line }), ...model.buttons.map(button)] })]
    for (const extra of [model.read, model.watch, model.unmapped].filter(Boolean)) {
      rows.push(Box({ flexDirection: 'row', gap: 2, children: [Text({ wrap: 'truncate', children: extra.line }), ...extra.buttons.map(button)] }))
    }
    return Box({ flexDirection: 'column', children: rows })
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const view = (await $.state.get(VIEW)).value ?? 'obligations'
    const { Box, Text } = $.ui.resolve(e)
    const lines = []
    if (view === 'inbox') {
      const rows = (await $.state.get(INBOX)).value ?? []
      lines.push(inboxList(rows, mod.lang))
      for (const row of rows.filter(one => one.read)) lines.push(`↻ ${row.read.title} › ${row.read.excerpt || row.read.block}`)
      lines.push(mod.lang === 'tr' ? '/ferrow:inbox ack N' : '/ferrow:inbox ack N')
    } else if (view === 'map') {
      const found = (await $.state.get(SUGGESTIONS)).value ?? null
      if (found?.error) lines.push(`ferrow: ${found.error}`)
      if (found?.unknown?.length) lines.push(...found.unknown, '')
      lines.push(...suggestLines(found?.rows ?? [], mod.lang))
    } else {
      lines.push(obligationsList((await $.state.get(OBLIGATIONS)).value ?? [], mod.lang))
      lines.push('/ferrow:obligations satisfy N · waive N <reason>')
    }
    return Box({ flexDirection: 'column', children: lines.map(text => Text({ children: text })) })
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'ferrow:status' }, async $ => {
    const session = (await $.state.get(SESSION)).value ?? null
    const touched = (await $.state.get(TOUCHED)).value ?? []
    return {
      text: [
        `session      ${session ?? 'none (session_begin not called yet)'}`,
        `lease        ${(await $.state.get(LEASE)).value ?? 'none'}`,
        `inbox        ${((await $.state.get(INBOX)).value ?? []).length}`,
        `obligations  ${((await $.state.get(OBLIGATIONS)).value ?? []).length} open`,
        `wake         ${await wakeMode($)}${mod.loop ? ' (polling)' : ''}`,
        `usage        ${usageLine((await $.state.get(USAGE)).value ?? NO_USAGE) ?? 'none yet'}`,
        `watchman     ${await watchmanMode($)}${watchStatus((await $.state.get(WATCH)).value, (await $.state.get(WATCH_USAGE)).value, (await $.state.get(WATCH_ERROR)).value)}`,
        `workspace    ${workspaceLine()}`,
        `server       ${mod.url} · ${tokenLine()}`,
        `edited       ${touched.length} file(s)`,
      ].join('\n'),
    }
  }).catch(() => ({ text: 'status unavailable' }))

  on('command.run', { command: 'ferrow:connect' }, async ($, e) => {
    const r = await connect($, (e.args ?? '').trim().split(/\s+/)[0] || null)
    const tr = mod.lang === 'tr'
    if (r.error) return { text: `ferrow: ${tr ? 'bağlanılamadı' : 'could not connect'} (${r.error})` }
    if (r.found) {
      const [workspace, ...agent] = r.found.connected.split(' ')
      const head = tr ? `ferrow: ${workspace} için zaten bağlı (${agent.join(' ')})` : `ferrow: already connected to ${workspace} as ${agent.join(' ')}`
      return { text: [head, ...loginNotes(r.found, mod.lang)].join('\n') }
    }
    return {
      text: tr
        ? `Tarayıcıda ${r.url} adresini aç ve ${r.code} kodunu onayla. Onaylayınca Ferrow kendiliğinden bağlanır.`
        : `Open ${r.url} and approve the code ${r.code}. Ferrow connects by itself once you do.`,
    }
  }).catch(() => ({ text: 'connect unavailable' }))

  on('command.run', { command: 'ferrow:logout' }, async $ => {
    if (mod.source !== 'file') {
      return { text: mod.source === 'env' ? 'connected with FERROW_AGENT_TOKEN; unset it to disconnect' : NOT_CONNECTED }
    }
    await endSession($).catch(() => {})
    const r = await $.process.run(await login($, ['--logout']), { timeoutMs: 20000 })
    const said = r.stdout.trim().split('\n').pop() ?? ''
    if (said !== 'disconnected') return { text: `ferrow: ${r.stderr.trim() || said || 'logout failed'}` }
    await loadToken($)
    if (!mod.token) {
      stopLoop()
      stopChecker()
      return { text: `disconnected from ${mod.url}; the token is revoked` }
    }
    return { text: `disconnected from ${mod.url}; the token is revoked, FERROW_AGENT_TOKEN still connects` }
  }).catch(() => ({ text: 'logout unavailable' }))

  on('command.run', { command: 'ferrow:wake' }, async ($, e) => {
    const mode = e.args.trim()
    if (!WAKES.includes(mode)) return { text: `wake is ${await wakeMode($)}; use on, ask or off` }
    await setWake($, mode)
    return { text: `wake ${mode}` }
  }).catch(() => ({ text: 'wake unchanged' }))

  on('command.run', { command: 'ferrow:watchman' }, async ($, e) => {
    const mode = e.args.trim()
    if (!WATCHMEN.includes(mode)) return { text: `watchman is ${await watchmanMode($)}; use on or off` }
    await $.store.set('watchman', mode)
    return { text: `watchman ${mode}` }
  }).catch(() => ({ text: 'watchman unchanged' }))

  on('command.run', { command: 'ferrow:inbox' }, async ($, e) => {
    if (!mod.token) return { text: NOT_CONNECTED }
    const session = (await $.state.get(SESSION)).value ?? null
    if (!session) return { text: 'no session yet (session_begin not called)' }
    const [verb, n] = e.args.trim().split(/\s+/)
    let rows = (await $.state.get(INBOX)).value ?? []
    if (verb === 'ack') {
      const row = rows[Number(n) - 1]
      if (!row) return { text: `no inbox row ${n ?? ''}`.trim() }
      await mcp($, 'inbox_ack', { notification_id: row.id })
      await setRows($, rows.filter(one => one.id !== row.id))
      return { text: `acknowledged ${row.item ?? row.id}` }
    }
    if (verb) return { text: 'use /ferrow:inbox or /ferrow:inbox ack N' }
    const res = await $.http.fetch(`${mod.url}/agent/inbox?session=${encodeURIComponent(session)}`, { headers: headers() })
    if (res.ok) {
      rows = (JSON.parse(res.text).notifications ?? []).map(slimRow)
      await setRows($, rows)
    }
    return { text: inboxList(rows, mod.lang) }
  }).catch(() => ({ text: 'inbox unavailable' }))

  on('command.run', { command: 'ferrow:obligations' }, async ($, e) => {
    if (!mod.token) return { text: NOT_CONNECTED }
    if (!(await $.state.get(SESSION)).value) return { text: 'no session yet (session_begin not called)' }
    const [verb, n, ...said] = e.args.trim().split(/\s+/)
    await refreshObligations($, true)
    const open = (await $.state.get(OBLIGATIONS)).value ?? []
    if (!verb) return { text: obligationsList(open, mod.lang) }
    const one = open[Number(n) - 1]
    if (!one || !['satisfy', 'waive'].includes(verb)) {
      return { text: 'use /ferrow:obligations, satisfy N, or waive N <reason>' }
    }
    const ws = encodeURIComponent(await workspace($))
    if (verb === 'satisfy') {
      await rest($, 'POST', `/api/v1/workspaces/${ws}/obligations/${one.id}/satisfy`, {})
    } else {
      const reason = said.join(' ').trim()
      if (reason.length < MIN_WAIVE) return { text: `a waive needs a reason of ${MIN_WAIVE} characters at least` }
      await rest($, 'POST', `/api/v1/workspaces/${ws}/obligations/${one.id}/waive`, { reason })
    }
    await refreshObligations($, true)
    return { text: `${verb === 'satisfy' ? 'satisfied' : 'waived'} ${one.label}` }
  }).catch(() => ({ text: 'obligations unavailable' }))

  on('command.run', { command: 'ferrow:pack' }, async $ => {
    if (!mod.token) return { text: NOT_CONNECTED }
    const lease = (await $.state.get(LEASE)).value ?? null
    if (!lease) return { text: 'no item claimed (item_claim first)' }
    const { text } = await mcp($, 'context_pack', { workspace: await workspace($), mode: 'item', item: lease })
    return { text: packText(text) }
  }).catch(() => ({ text: 'pack unavailable' }))

  on('command.run', { command: 'ferrow:map' }, async ($, e) => {
    const list = await recheck($, (await $.state.get(UNMAPPED)).value ?? [])
    await $.state.set(UNMAPPED, list)
    const [verb, n] = (e?.args ?? '').trim().split(/\s+/)
    if (verb === 'create') return { text: await createMapped($, list, Number(n)) }
    const found = await sessionMap($, list)
    if (!found) return { text: mapReport({ cwd: await $.session.cwd() }, mod.lang) }
    let entries
    try {
      entries = parseRepoMap(found.text)
    } catch (error) {
      return { text: mapReport({ file: found.file, error: `ferrow.toml does not parse: ${error?.message ?? error}` }, mod.lang) }
    }
    const checked = await checkMap($, found.text)
    let suggestions = null
    if (list.length > 0 && mod.token) {
      suggestions = await suggestionsFor($, list).catch(() => null)
      if (suggestions) await $.state.set(SUGGESTIONS, { rows: suggestions, error: null })
    }
    return {
      text: mapReport({ file: found.file, entries, checked, unmapped: list.map(one => one.path), suggestions }, mod.lang),
    }
  }).catch(() => ({ text: 'map unavailable' }))
}
