const GIT = ['status', 'diff', 'log', 'show', 'add', 'commit', 'switch', 'branch', 'restore', 'mv', 'rm']

export const ALLOWED_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'TodoWrite',
  'Edit(/**)',
  ...GIT.flatMap(command => [`Bash(git ${command})`, `Bash(git ${command} *)`]),
  'mcp__plugin_ferrow_ferrow__*',
]

export function claudeOptions({ cwd, system, clientSession, resume, pluginDir, model, allow = [], yolo = false, abortController, env = {} }) {
  return {
    cwd,
    plugins: [{ type: 'local', path: pluginDir }],
    systemPrompt: { type: 'preset', preset: 'claude_code', append: system },
    settingSources: ['project'],
    env: { ...process.env, ...env, FERROW_DAEMON: '1' },
    ...(yolo
      ? { permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true }
      : { permissionMode: 'dontAsk', allowedTools: [...ALLOWED_TOOLS, ...allow] }),
    ...(resume ? { resume: clientSession } : { sessionId: clientSession }),
    ...(model ? { model } : {}),
    ...(abortController ? { abortController } : {}),
  }
}

export function usageOf(result) {
  const models = Object.values(result?.modelUsage ?? {})
  if (models.length === 0) {
    const u = result?.usage ?? {}
    return {
      tokensIn: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
      tokensOut: u.output_tokens ?? 0,
    }
  }
  return models.reduce(
    (sum, m) => ({
      tokensIn: sum.tokensIn + (m.inputTokens ?? 0) + (m.cacheReadInputTokens ?? 0) + (m.cacheCreationInputTokens ?? 0),
      tokensOut: sum.tokensOut + (m.outputTokens ?? 0),
    }),
    { tokensIn: 0, tokensOut: 0 },
  )
}

async function sdkQuery() {
  const sdk = await import('@anthropic-ai/claude-agent-sdk')
  return sdk.query
}

export function claudeBackend({ query, pluginDir, model, allow = [], yolo = false } = {}) {
  return {
    name: 'claude',
    client: 'claude_code',
    presetsSession: true,
    describe: ({ cwd, clientSession, resume }) => ({
      cwd,
      client_session: clientSession,
      resume,
      permission_mode: yolo ? 'bypassPermissions' : 'dontAsk',
    }),
    async run({ cwd, prompt, system, clientSession, resume, signal, env, allow: more = [] }) {
      const abortController = new AbortController()
      const abort = () => abortController.abort()
      if (signal?.aborted) abort()
      signal?.addEventListener('abort', abort, { once: true })
      const run = query ?? (await sdkQuery())
      let result = null
      try {
        const options = claudeOptions({ cwd, system, clientSession, resume, pluginDir, model, allow: [...allow, ...more], yolo, abortController, env })
        for await (const message of run({ prompt, options })) {
          if (message.type === 'result') result = message
        }
      } catch (error) {
        if (signal?.aborted) return { ok: false, interrupted: true, error: 'interrupted', clientSession }
        return { ok: false, error: String(error?.message ?? error), clientSession }
      } finally {
        signal?.removeEventListener('abort', abort)
      }
      if (signal?.aborted) return { ok: false, interrupted: true, error: 'interrupted', clientSession }
      if (!result) return { ok: false, error: 'the session ended without a result', clientSession }
      const usage = usageOf(result)
      const ok = result.subtype === 'success' && !result.is_error
      return {
        ok,
        text: ok ? result.result : '',
        error: ok ? undefined : result.errors?.join('; ') || result.result || result.subtype,
        costUsd: result.total_cost_usd,
        ...usage,
        clientSession: result.session_id ?? clientSession,
      }
    },
  }
}
