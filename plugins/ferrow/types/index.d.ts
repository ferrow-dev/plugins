export type FerrowWake = 'on' | 'ask' | 'off'

export type FerrowRow = {
  id: string
  item: string | null
  reason: string
  kind: string
  trust: string | null
  read?: FerrowRead
}

export type FerrowRead = {
  page: string
  block: string
  title: string
  excerpt: string
  old: string | null
  new: string | null
}

export type FerrowObligation = { id: string; status: string; reason: string; label: string }

export type FerrowUsage = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  micros: number
  priceUnknown: boolean
  turns: number
}

export type FerrowReported = { tokens_in: number; tokens_out: number; cost_cents: number }

export type FerrowWatchman = 'on' | 'off'

export type FerrowWatch = {
  flags: { page: string; block: string; reason: string }[]
  confirms: { page: string; block: string }[]
}

export type FerrowTurn = { id: string | null; ferrow: boolean; paths: string[] }

export type FerrowPack = { item: string; asOf: string }

declare module 'claude-code' {
  interface PluginState {
    ferrow: {
      session: string | null
      lease: string | null
      claimed: string[]
      leaseUntil: string | null
      inbox: FerrowRow[]
      pending: string[]
      obligations: FerrowObligation[]
      checked: number | null
      wake: FerrowWake
      view: 'obligations' | 'inbox'
      usage: FerrowUsage
      reported: FerrowReported | null
      workspace: string | null
      touched: string[]
      notified: string[]
      busy: boolean
      turn: FerrowTurn | null
      forked: string | null
      watch: FerrowWatch | null
      watchUsage: FerrowUsage
      watchError: string | null
      pack: FerrowPack | null
      briefed: string | null
      unmapped: string[]
      suggestions: { rows: unknown[]; error: string | null } | null
      connecting: { code: string; url: string } | null
    }
  }
}
