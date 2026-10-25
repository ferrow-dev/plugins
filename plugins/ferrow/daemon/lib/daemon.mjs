import { randomUUID } from 'node:crypto'
import { cleanRemote, credentialEnv } from './credential.mjs'
import { ensure, finish, git as runGit, origin, plan, remoteHead } from './worktree.mjs'
import { feedbackOf, protocol, summaryComment, taskPrompt } from './prompt.mjs'

const WAKES = new Set(['delegated', 'pr_feedback'])

export function pushRules(branch) {
  return [`Bash(git push origin ${branch})`, `Bash(git push -u origin ${branch})`]
}

const sleep = (ms, signal) =>
  new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true })
  })

export function projectOf(key) {
  return key.slice(0, key.lastIndexOf('-'))
}

export function createDaemon({
  ferrow,
  backend,
  repo,
  root,
  base = 'main',
  parallel = 1,
  once = false,
  dryRun = false,
  waitS = 25,
  idleMs = 30_000,
  retryMs = 300_000,
  renewMs = 600_000,
  state,
  log,
  home,
  dispatcherId,
  newId = randomUUID,
}) {
  const active = new Map()
  const skipped = new Map()
  const controller = new AbortController()
  let dispatcher = null
  let workspace = null
  let stopping = false
  let handled = 0

  async function begin(clientSession) {
    const out = await ferrow.mcp('session_begin', { client: backend.client, wake_method: 'daemon', client_session: clientSession })
    return out.session_id
  }

  async function beginDispatcher() {
    dispatcher = await begin(dispatcherId)
    return dispatcher
  }

  async function claim(key, session) {
    try {
      await ferrow.mcp('item_claim', { item: key, session })
      return true
    } catch (error) {
      if (error.code !== 'item_leased') throw error
      log('skipped_leased', { item: key, reason: error.message })
      return false
    }
  }

  async function quietly(what, fields, run) {
    try {
      return await run()
    } catch (error) {
      log(`${what}_failed`, { ...fields, error: String(error?.message ?? error) })
      return undefined
    }
  }

  const release = (key, session) =>
    quietly('release', { item: key }, () => ferrow.mcp('item_release', { item: key, session }).catch(error => {
      if (error.code !== 'lease_not_held') throw error
    }))

  const end = (session, outcome) =>
    quietly('session_end', { session }, () =>
      ferrow
        .rest('PATCH', `/agent/sessions/${encodeURIComponent(session)}`, {
          state: outcome.ok ? 'ended' : 'failed',
          ...(typeof outcome.summary === 'string' ? { summary: outcome.summary } : {}),
          ...(outcome.tokensIn !== undefined ? { tokens_in: outcome.tokensIn, tokens_out: outcome.tokensOut ?? 0 } : {}),
          ...(typeof outcome.costUsd === 'number' ? { cost_cents: Math.round(outcome.costUsd * 100) } : {}),
        })
        .catch(error => {
          if (error.code !== 'session_closed') throw error
        }),
    )

  function actionable(row, now) {
    if (!WAKES.has(row.reason) || typeof row.item !== 'string') return false
    if (active.has(row.item)) return false
    const until = skipped.get(row.id)
    return !(until && until > now)
  }

  // Asking for a credential is the only way to learn whether the item's repo
  // is connected; the answer's token is dropped here and never logged.
  async function connection(key) {
    const url = await origin(repo)
    if (!url) {
      log('git', { item: key, connected: false, reason: 'no_origin' })
      return null
    }
    const remote = cleanRemote(url)
    const env = credentialEnv({ origin: remote, item: key })
    if (!env) {
      log('git', { item: key, connected: false, reason: 'origin_unreadable' })
      return null
    }
    try {
      const out = await ferrow.rest('POST', '/agent/git/credential', { item: key, remote })
      const full = typeof out?.repo_full_name === 'string' ? out.repo_full_name : null
      log('git', { item: key, connected: true, repo: full })
      return { remote, repo: full, env }
    } catch (error) {
      log('git', { item: key, connected: false, reason: error?.code ?? 'error' })
      return null
    }
  }

  const itemOf = key =>
    quietly('item_get', { item: key }, () => ferrow.mcp('work_item_get', { workspace, project: projectOf(key), item: key }))

  async function handle(row) {
    const key = row.item
    log('picked', { notification: row.id, item: key, backend: backend.name })
    const item = await itemOf(key)
    if (dryRun) {
      const { path, branch } = plan({ root, key })
      skipped.set(row.id, Infinity)
      log('dry_run', {
        item: key,
        worktree: path,
        branch,
        base,
        backend: backend.name,
        run: backend.describe({ cwd: path, clientSession: state.get(key)?.client_session ?? null, resume: Boolean(state.get(key)) }),
        prompt: taskPrompt(row, item),
      })
      return
    }

    const prior = state.get(key)
    let clientSession = prior?.backend === backend.name ? prior.client_session : null
    const resume = Boolean(clientSession)
    if (!clientSession && backend.presetsSession) clientSession = newId()
    let session = null
    let holder = null
    let worktree = null
    let link = null
    let outcome
    const feedback = Boolean(feedbackOf(row))
    const remember = () => state.set(key, { backend: backend.name, client_session: clientSession, worktree: plan({ root, key }).path })

    try {
      if (clientSession) {
        session = await begin(clientSession)
        if (!(await claim(key, session))) {
          await end(session, { ok: true })
          skipped.set(row.id, Date.now() + retryMs)
          return
        }
        holder = session
        remember()
        await beginDispatcher()
      } else {
        if (!(await claim(key, dispatcher))) {
          skipped.set(row.id, Date.now() + retryMs)
          return
        }
        holder = dispatcher
      }
      link = await connection(key)
      worktree = await ensure({ repo, root, key, base, feedback, env: link?.env })
      log('worktree', { item: key, path: worktree.path, branch: worktree.branch, base: worktree.base, reused: worktree.reused, from: worktree.from })
      const system = protocol({ workspace, item: key, session: backend.presetsSession ? session : null, worktree, git: link, feedback })
      const renew = setInterval(() => {
        if (holder) quietly('renew', { item: key }, () => ferrow.mcp('item_claim', { item: key, session: holder }))
      }, renewMs)
      try {
        log('session_start', { item: key, session, ...backend.describe({ cwd: worktree.path, clientSession, resume }) })
        outcome = await backend.run({
          cwd: worktree.path,
          prompt: taskPrompt(row, item),
          system,
          clientSession,
          resume,
          ...(link ? { env: link.env, allow: pushRules(worktree.branch), network: true } : {}),
          signal: controller.signal,
          onThread: async thread => {
            if (thread === clientSession && session) return
            clientSession = thread
            session = await begin(thread)
            remember()
            const reserved = holder !== null && holder !== session ? holder : null
            await beginDispatcher()
            if (reserved) {
              await release(key, reserved)
              holder = (await claim(key, session)) ? session : null
            }
            log('thread', { item: key, thread, session })
          },
        })
      } finally {
        clearInterval(renew)
      }
    } catch (error) {
      outcome = { ok: false, error: String(error?.message ?? error) }
    }

    if (outcome.interrupted) {
      if (holder) await release(key, holder)
      log('interrupted', { item: key, session })
      return
    }
    const push =
      worktree && link
        ? await quietly('push_check', { item: key }, async () => ({
            repo: link.repo,
            head: await runGit(worktree.path, ['rev-parse', 'HEAD']),
            remote: await remoteHead({ repo, branch: worktree.branch, env: link.env }),
          }))
        : null
    const finished = worktree ? await quietly('worktree_finish', { item: key }, () => finish({ repo, worktree, base })) : null
    const body = summaryComment({ backend: backend.name, outcome, worktree, finished, home, push })
    await quietly('comment', { item: key }, () =>
      ferrow.mcp('work_item_comment_add', { workspace, project: projectOf(key), item: key, body }),
    )
    if (holder) await release(key, holder)
    if (session) await end(session, outcome)
    let acked = false
    if (outcome.ok) {
      acked = (await quietly('ack', { notification: row.id }, () => ferrow.mcp('inbox_ack', { notification_id: row.id }).then(() => true))) ?? false
    } else {
      skipped.set(row.id, Date.now() + retryMs)
    }
    if (!worktree || finished?.removed) state.delete(key)
    handled += 1
    log('done', {
      item: key,
      ok: outcome.ok,
      ...(outcome.ok ? {} : { error: outcome.error }),
      acked,
      session,
      worktree_removed: finished?.removed ?? null,
      ahead: finished?.ahead ?? null,
    })
  }

  function start(row) {
    const work = handle(row)
      .catch(error => log('handle_failed', { item: row.item, error: String(error?.message ?? error) }))
      .finally(() => active.delete(row.item))
    active.set(row.item, work)
    return work
  }

  async function slot() {
    while (active.size >= parallel) await Promise.race(active.values())
  }

  async function run() {
    await beginDispatcher()
    try {
      await loop()
    } finally {
      await Promise.all(active.values())
      const summary = `ferrow-daemon (${backend.name}) stopped after ${handled} delegation${handled === 1 ? '' : 's'}${dryRun ? ', dry run' : ''}`
      await end(dispatcher, { ok: true, summary })
      log('stopped', { session: dispatcher, handled })
    }
  }

  async function loop() {
    const spaces = await ferrow.mcp('workspace_list', {})
    workspace = Array.isArray(spaces) ? spaces[0]?.slug : null
    if (typeof workspace !== 'string') throw new Error('no_workspace: the agent token reaches no workspace')
    log('started', { backend: backend.name, repo, base, parallel, once, dry_run: dryRun, session: dispatcher, workspace })

    while (!stopping) {
      await slot()
      if (stopping) break
      let rows
      try {
        rows = await ferrow.inbox({ session: dispatcher, wait: waitS, signal: controller.signal })
      } catch (error) {
        if (stopping) break
        log('poll_failed', { error: String(error?.message ?? error) })
        if (error.code === 'session_closed' || error.code === 'no_session') await quietly('begin', {}, beginDispatcher)
        else await sleep(idleMs, controller.signal)
        if (once) break
        continue
      }
      const now = Date.now()
      const picked = []
      for (const row of rows) {
        if (actionable(row, now) && !picked.some(other => other.item === row.item)) picked.push(row)
      }
      if (once) {
        for (const row of picked) {
          await slot()
          start(row)
        }
        break
      }
      let started = 0
      for (const row of picked) {
        if (active.size >= parallel) break
        start(row)
        started += 1
      }
      if (started === 0 && rows.length > 0) {
        await Promise.race([sleep(idleMs, controller.signal), ...active.values()])
      }
    }
  }

  function stop() {
    stopping = true
    controller.abort()
  }

  return { run, stop }
}
