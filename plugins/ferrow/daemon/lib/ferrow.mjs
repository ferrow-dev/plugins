export class FerrowError extends Error {
  constructor(code, message) {
    super(message ? `${code}: ${message}` : code)
    this.code = code
  }
}

function codeOf(text, status) {
  try {
    const body = JSON.parse(text)
    return body?.error?.code ?? body?.code ?? `http_${status}`
  } catch {
    return `http_${status}`
  }
}

function rpcBody(text) {
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) return JSON.parse(trimmed)
  const data = trimmed
    .split('\n')
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trim())
    .pop()
  return JSON.parse(data ?? '{}')
}

export function ferrowClient({ url, token, client, fetch = globalThis.fetch }) {
  const base = url.replace(/\/+$/, '')
  const headers = (extra = {}) => ({ Authorization: `Bearer ${token}`, 'X-Ferrow-Client': client, ...extra })
  let id = 0

  async function mcp(name, args = {}, session) {
    const res = await fetch(`${base}/mcp/agent`, {
      method: 'POST',
      headers: headers({
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(session ? { 'X-Ferrow-Session': session } : {}),
      }),
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }),
    })
    const text = await res.text()
    if (!res.ok) throw new FerrowError(codeOf(text, res.status))
    const body = rpcBody(text)
    if (body.error) throw new FerrowError('mcp_error', body.error.message)
    const out = body.result?.content?.[0]?.text ?? ''
    if (body.result?.isError) {
      const match = /^([a-z_]+):\s*([\s\S]*)$/.exec(out)
      throw match ? new FerrowError(match[1], match[2]) : new FerrowError('tool_error', out)
    }
    if (body.result?.structuredContent !== undefined) return body.result.structuredContent
    try {
      return JSON.parse(out)
    } catch {
      return out
    }
  }

  async function rest(method, path, body) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: headers(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await res.text()
    if (!res.ok) throw new FerrowError(codeOf(text, res.status))
    return text ? JSON.parse(text) : null
  }

  async function inbox({ session, wait, signal }) {
    const query = new URLSearchParams({ wait: String(wait), session })
    const res = await fetch(`${base}/agent/inbox?${query}`, { headers: headers(), signal })
    const text = await res.text()
    // A gateway that cut the wait short answered nothing new.
    if (res.status === 504) return []
    if (!res.ok) throw new FerrowError(codeOf(text, res.status))
    return JSON.parse(text).notifications ?? []
  }

  return { mcp, rest, inbox }
}
