import { fileURLToPath } from 'node:url'

export const HELPER = fileURLToPath(new URL('../git-credential-ferrow.mjs', import.meta.url))

export function remoteOf(url) {
  const text = String(url ?? '').trim()
  let match = /^(?:https?):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/.exec(text)
  if (match) return { host: match[1], path: match[2], ssh: null }
  match = /^ssh:\/\/((?:[^@/]+@)?([^/:]+)(?::\d+)?)\/(.+)$/.exec(text)
  if (match) return { host: match[2], path: match[3], ssh: `ssh://${match[1]}/` }
  match = /^((?:[^@/]+@)?([^/:]+)):(?!\/\/)(.+)$/.exec(text)
  if (match) return { host: match[2], path: match[3], ssh: `${match[1]}:` }
  return null
}

// An https origin may carry a user and password; neither goes into a prompt,
// a log line or a request.
export function cleanRemote(url) {
  return String(url ?? '').trim().replace(/^(https?:\/\/)[^@/]+@/, '$1')
}

const quote = value => `"${String(value).replace(/(["\\$`])/g, '\\$1')}"`

// Git reads this configuration from the environment of the agent's process
// only: no config file, no argv. The empty value first drops every helper
// configured for the host (a keychain would otherwise answer, and be asked
// to store the token).
export function credentialEnv({ origin, item, base = process.env, node = process.execPath, helper = HELPER }) {
  const remote = remoteOf(origin)
  if (!remote) return null
  const https = `https://${remote.host}`
  const pairs = [
    [`credential.${https}.helper`, ''],
    [`credential.${https}.helper`, `!${quote(node)} ${quote(helper)}`],
    [`credential.${https}.useHttpPath`, 'true'],
    ...(remote.ssh ? [[`url.${https}/.insteadOf`, remote.ssh]] : []),
  ]
  const start = Number(base.GIT_CONFIG_COUNT) || 0
  const env = {
    GIT_TERMINAL_PROMPT: '0',
    FERROW_GIT_ITEM: item,
    FERROW_GIT_REMOTE: cleanRemote(origin),
    GIT_CONFIG_COUNT: String(start + pairs.length),
  }
  pairs.forEach(([key, value], at) => {
    env[`GIT_CONFIG_KEY_${start + at}`] = key
    env[`GIT_CONFIG_VALUE_${start + at}`] = value
  })
  return env
}

export function parseInput(text) {
  const fields = {}
  for (const line of String(text).split('\n')) {
    if (line === '') continue
    const at = line.indexOf('=')
    if (at > 0) fields[line.slice(0, at)] = line.slice(at + 1)
  }
  return fields
}

function codeOf(text, status) {
  try {
    const body = JSON.parse(text)
    return body?.error?.code ?? body?.code ?? `http_${status}`
  } catch {
    return `http_${status}`
  }
}

// The answer git reads on stdout; nothing else is ever written there, and
// the password goes nowhere else.
export async function helper({ op, input, env = process.env, fetch = globalThis.fetch }) {
  if (op !== 'get') return { stdout: '', stderr: '', code: 0 }
  const fields = parseInput(input)
  const token = env.FERROW_AGENT_TOKEN
  const item = env.FERROW_GIT_ITEM
  if (!token || !item) return { stdout: '', stderr: 'ferrow credential: FERROW_AGENT_TOKEN or FERROW_GIT_ITEM is not set\n', code: 0 }
  const remote =
    fields.protocol && fields.host && fields.path ? `${fields.protocol}://${fields.host}/${fields.path}` : env.FERROW_GIT_REMOTE
  if (!remote) return { stdout: '', stderr: 'ferrow credential: no remote to ask for\n', code: 0 }
  const base = (env.FERROW_URL || 'https://app.ferrow.dev').replace(/\/+$/, '')
  let res
  let text
  try {
    res = await fetch(`${base}/agent/git/credential`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ item, remote }),
    })
    text = await res.text()
  } catch (error) {
    return { stdout: '', stderr: `ferrow credential: Ferrow unreachable (${error?.cause?.code ?? error?.name ?? 'error'})\n`, code: 0 }
  }
  if (!res.ok) return { stdout: '', stderr: `ferrow credential: ${codeOf(text, res.status)}\n`, code: 0 }
  let body
  try {
    body = JSON.parse(text)
  } catch {
    return { stdout: '', stderr: 'ferrow credential: unreadable answer\n', code: 0 }
  }
  if (typeof body?.username !== 'string' || typeof body?.password !== 'string' || /[\n\0]/.test(body.username + body.password)) {
    return { stdout: '', stderr: 'ferrow credential: unreadable answer\n', code: 0 }
  }
  const lines = [`username=${body.username}`, `password=${body.password}`]
  const expiry = Date.parse(body.expires_at ?? '')
  if (Number.isFinite(expiry)) lines.push(`password_expiry_utc=${Math.floor(expiry / 1000)}`)
  return { stdout: `${lines.join('\n')}\n`, stderr: '', code: 0 }
}
