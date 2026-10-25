import { execFile } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const KEY = /^[A-Za-z][A-Za-z0-9_]*-[0-9]+$/

export function git(cwd, args, env) {
  return new Promise((resolve, reject) => {
    const options = { maxBuffer: 16 * 1024 * 1024, ...(env ? { env: { ...process.env, ...env } } : {}) }
    execFile('git', ['-C', cwd, ...args], options, (error, stdout, stderr) => {
      if (error) reject(new Error(`git ${args[0]}: ${(stderr || error.message).trim()}`))
      else resolve(stdout.trim())
    })
  })
}

async function succeeds(cwd, args, env) {
  try {
    await git(cwd, args, env)
    return true
  } catch {
    return false
  }
}

export function plan({ root, key }) {
  if (!KEY.test(key)) throw new Error(`not an item key: ${key}`)
  return { path: join(root, key), branch: `ferrow/${key}` }
}

export async function origin(repo) {
  try {
    return (await git(repo, ['config', '--get', 'remote.origin.url'])) || null
  } catch {
    return null
  }
}

// A feedback round goes on the branch the pull request is open from: the
// local one, else the one on origin; fast-forwarded when a person pushed to
// it meanwhile.
async function fetchBranch(repo, branch, env) {
  const tracking = `refs/remotes/origin/${branch}`
  if (!(await succeeds(repo, ['fetch', '--quiet', 'origin', `+refs/heads/${branch}:${tracking}`], env))) return null
  return git(repo, ['rev-parse', '--verify', `${tracking}^{commit}`])
}

async function fastForward(path, remote) {
  const head = await git(path, ['rev-parse', 'HEAD'])
  if (head === remote) return false
  if (!(await succeeds(path, ['merge-base', '--is-ancestor', head, remote]))) return false
  if ((await git(path, ['status', '--porcelain'])) !== '') return false
  await git(path, ['merge', '--ff-only', '--quiet', remote])
  return true
}

export async function ensure({ repo, root, key, base, feedback = false, env }) {
  const { path, branch } = plan({ root, key })
  const baseCommit = await git(repo, ['rev-parse', '--verify', `${base}^{commit}`])
  const remote = feedback ? await fetchBranch(repo, branch, env) : null
  const done = async (reused, from, forwarded = false) => ({
    path,
    branch,
    base: baseCommit,
    head: await git(path, ['rev-parse', 'HEAD']),
    reused,
    from,
    ...(forwarded ? { forwarded } : {}),
  })
  if (existsSync(path) && (await succeeds(path, ['rev-parse', '--is-inside-work-tree']))) {
    return done(true, 'worktree', remote ? await fastForward(path, remote) : false)
  }
  mkdirSync(root, { recursive: true })
  await git(repo, ['worktree', 'prune'])
  if (await succeeds(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])) {
    await git(repo, ['worktree', 'add', path, branch])
    return done(false, 'local', remote ? await fastForward(path, remote) : false)
  }
  if (remote) {
    await git(repo, ['worktree', 'add', '-b', branch, path, remote])
    return done(false, 'origin')
  }
  await git(repo, ['worktree', 'add', '-b', branch, path, baseCommit])
  return done(false, 'base')
}

// The commit origin has for the branch: a sha, null when origin has no such
// branch, undefined when origin could not be asked.
export async function remoteHead({ repo, branch, env }) {
  try {
    const line = await git(repo, ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`], env)
    return line.split(/\s+/)[0] || null
  } catch {
    return undefined
  }
}

export async function finish({ repo, worktree, base }) {
  const ahead = Number(await git(repo, ['rev-list', '--count', `${base}..${worktree.branch}`]))
  const dirty = (await git(worktree.path, ['status', '--porcelain'])) !== ''
  if (ahead === 0 && !dirty) {
    await git(repo, ['worktree', 'remove', worktree.path])
    await git(repo, ['branch', '-D', worktree.branch])
    return { removed: true, ahead, dirty }
  }
  return { removed: false, ahead, dirty }
}
