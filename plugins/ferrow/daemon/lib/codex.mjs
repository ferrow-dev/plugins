import { spawn as nodeSpawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const STDERR_KEEP = 4000

export function codexArgs({ cwd, thread, yolo = false, model, network = false }) {
  const flags = [
    '--json',
    '--skip-git-repo-check',
    '-C',
    cwd,
    ...(yolo ? ['--dangerously-bypass-approvals-and-sandbox'] : ['--sandbox', 'workspace-write']),
    ...(network && !yolo ? ['-c', 'sandbox_workspace_write.network_access=true'] : []),
    ...(model ? ['--model', model] : []),
  ]
  return thread ? ['exec', ...flags, 'resume', thread, '-'] : ['exec', ...flags, '-']
}

export function codexReader() {
  const out = { thread: null, ok: false, text: '', error: null, tokensIn: 0, tokensOut: 0, turns: 0 }
  function read(line) {
    let event
    try {
      event = JSON.parse(line)
    } catch {
      return null
    }
    switch (event?.type) {
      case 'thread.started':
        if (typeof event.thread_id === 'string') out.thread = event.thread_id
        return { thread: out.thread }
      case 'item.completed':
        if (event.item?.type === 'agent_message' && typeof event.item.text === 'string') out.text = event.item.text
        return null
      case 'turn.completed':
        out.ok = true
        out.error = null
        out.turns += 1
        out.tokensIn += event.usage?.input_tokens ?? 0
        out.tokensOut += event.usage?.output_tokens ?? 0
        return null
      case 'turn.failed':
        out.ok = false
        out.error = event.error?.message ?? 'turn failed'
        return null
      case 'error':
        out.error = event.message ?? event.error?.message ?? 'error'
        return null
      default:
        return null
    }
  }
  return { read, result: () => out }
}

export function parseCodexJsonl(text) {
  const reader = codexReader()
  for (const line of text.split('\n')) if (line.trim()) reader.read(line)
  return reader.result()
}

export function codexBackend({ spawn = nodeSpawn, bin = 'codex', yolo = false, model } = {}) {
  return {
    name: 'codex',
    client: 'codex',
    presetsSession: false,
    describe: ({ cwd, clientSession }) => ({
      command: [bin, ...codexArgs({ cwd, thread: clientSession, yolo, model })],
      stdin: '<prompt>',
    }),
    run({ cwd, prompt, system, clientSession, signal, onThread, env, network = false }) {
      const args = codexArgs({ cwd, thread: clientSession, yolo, model, network })
      return new Promise(resolve => {
        const child = spawn(bin, args, { cwd, env: { ...process.env, ...env, FERROW_DAEMON: '1' }, stdio: ['pipe', 'pipe', 'pipe'] })
        child.stdin?.on('error', () => {})
        child.stdin?.end(`${system}\n\n---\n\n${prompt}`)
        const reader = codexReader()
        const pending = []
        let stderr = ''
        let spawnError = null
        const kill = () => child.kill('SIGTERM')
        signal?.addEventListener('abort', kill, { once: true })
        createInterface({ input: child.stdout }).on('line', line => {
          const seen = reader.read(line)
          if (seen?.thread && onThread) pending.push(Promise.resolve(onThread(seen.thread)).catch(() => {}))
        })
        child.stderr.on('data', chunk => (stderr = (stderr + chunk).slice(-STDERR_KEEP)))
        child.on('error', error => (spawnError = error))
        child.on('close', async code => {
          signal?.removeEventListener('abort', kill)
          await Promise.all(pending)
          const out = reader.result()
          const base = { text: out.text, tokensIn: out.tokensIn, tokensOut: out.tokensOut, clientSession: out.thread ?? clientSession }
          if (signal?.aborted) return resolve({ ...base, ok: false, interrupted: true, error: 'interrupted' })
          if (spawnError) return resolve({ ...base, ok: false, error: `${bin}: ${spawnError.message}` })
          if (code !== 0 || !out.ok) {
            return resolve({ ...base, ok: false, error: out.error ?? (stderr.trim() || `${bin} exited with ${code}`) })
          }
          resolve({ ...base, ok: true })
        })
      })
    },
  }
}
