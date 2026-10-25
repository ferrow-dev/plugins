import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export function fileState(path) {
  let items = {}
  try {
    items = JSON.parse(readFileSync(path, 'utf8')).items ?? {}
  } catch {
    items = {}
  }
  const save = () => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(`${path}.tmp`, `${JSON.stringify({ items }, null, 2)}\n`, { mode: 0o600 })
    renameSync(`${path}.tmp`, path)
  }
  return {
    get: key => items[key] ?? null,
    set(key, value) {
      items[key] = value
      save()
    },
    delete(key) {
      if (!(key in items)) return
      delete items[key]
      save()
    },
  }
}

export function memoryState() {
  const items = {}
  return {
    items,
    get: key => items[key] ?? null,
    set: (key, value) => void (items[key] = value),
    delete: key => void delete items[key],
  }
}
