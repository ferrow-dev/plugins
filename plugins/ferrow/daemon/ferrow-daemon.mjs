#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { claudeBackend } from './lib/claude.mjs'
import { codexBackend } from './lib/codex.mjs'
import { createDaemon } from './lib/daemon.mjs'
import { ferrowClient } from './lib/ferrow.mjs'
import { fileState } from './lib/state.mjs'
import { git } from './lib/worktree.mjs'

const USAGE = `ferrow-daemon --repo <path> [--backend claude|codex] [--once] [--parallel N] [--dry-run]
              [--base main] [--model <id>] [--allow <rule>]... [--idle <seconds>]
              [--retry <seconds>] [--dangerously-skip-permissions]
env: FERROW_AGENT_TOKEN (required), FERROW_URL, FERROW_DAEMON_HOME (~/.cache/ferrow)`

export function parseCli(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      repo: { type: 'string' },
      backend: { type: 'string', default: 'claude' },
      once: { type: 'boolean', default: false },
      parallel: { type: 'string', default: '1' },
      'dry-run': { type: 'boolean', default: false },
      base: { type: 'string', default: 'main' },
      model: { type: 'string' },
      allow: { type: 'string', multiple: true, default: [] },
      idle: { type: 'string', default: '30' },
      retry: { type: 'string', default: '300' },
      'dangerously-skip-permissions': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  })
  if (values.help) return { help: true }
  if (!values.repo) throw new Error('--repo is required')
  if (!['claude', 'codex'].includes(values.backend)) throw new Error('--backend is claude or codex')
  const parallel = Number(values.parallel)
  if (!Number.isInteger(parallel) || parallel < 1 || parallel > 8) throw new Error('--parallel is 1 to 8')
  const idle = Number(values.idle)
  if (!Number.isFinite(idle) || idle < 1) throw new Error('--idle is a number of seconds, at least 1')
  const retry = Number(values.retry)
  if (!Number.isFinite(retry) || retry < 1) throw new Error('--retry is a number of seconds, at least 1')
  return {
    repo: values.repo,
    backend: values.backend,
    once: values.once,
    parallel,
    dryRun: values['dry-run'],
    base: values.base,
    model: values.model,
    allow: values.allow,
    idleMs: idle * 1000,
    retryMs: retry * 1000,
    yolo: values['dangerously-skip-permissions'],
  }
}

function log(event, fields) {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), event, ...fields })}\n`)
}

async function main() {
  let cli
  try {
    cli = parseCli(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error.message}\n${USAGE}\n`)
    process.exit(2)
  }
  if (cli.help) {
    process.stdout.write(`${USAGE}\n`)
    return
  }
  const token = process.env.FERROW_AGENT_TOKEN
  if (!token) {
    process.stderr.write('FERROW_AGENT_TOKEN is not set\n')
    process.exit(2)
  }
  const repo = await git(resolve(cli.repo), ['rev-parse', '--show-toplevel'])
  const daemonHome = process.env.FERROW_DAEMON_HOME || join(homedir(), '.cache', 'ferrow')
  const pluginDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const backend =
    cli.backend === 'codex'
      ? codexBackend({ yolo: cli.yolo, model: cli.model })
      : claudeBackend({ pluginDir, model: cli.model, allow: cli.allow, yolo: cli.yolo })
  const ferrow = ferrowClient({
    url: process.env.FERROW_URL || 'https://app.ferrow.dev',
    token,
    client: backend.client,
  })
  const tag = createHash('sha256').update(realpathSync(repo)).digest('hex').slice(0, 12)
  const daemon = createDaemon({
    ferrow,
    backend,
    repo,
    root: join(daemonHome, 'wt'),
    base: cli.base,
    parallel: cli.parallel,
    once: cli.once,
    dryRun: cli.dryRun,
    idleMs: cli.idleMs,
    retryMs: cli.retryMs,
    state: fileState(join(daemonHome, 'daemon', `${tag}.json`)),
    log,
    home: homedir(),
    dispatcherId: `ferrow-daemon:${hostname()}:${tag}:${backend.name}`,
  })
  if (cli.yolo) log('warning', { message: 'permission checks are off (--dangerously-skip-permissions)' })
  const stop = () => daemon.stop()
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  await daemon.run()
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    log('fatal', { error: String(error?.message ?? error) })
    process.exit(1)
  })
}
