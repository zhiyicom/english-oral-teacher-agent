import { randomUUID } from 'node:crypto'
import type { DbHandle } from './db.js'

export interface Session {
  id: string
  started_at: string
  ended_at: string | null
  duration_min: number | null
}

export interface CreateSessionInput {
  id?: string
  startedAt?: string
}

export interface MarkEndedInput {
  endedAt?: string
  durationMin?: number
}

export interface SessionsDao {
  create(input?: CreateSessionInput): Session
  get(id: string): Session | null
  list(): Session[]
  markEnded(id: string, opts?: MarkEndedInput): Session
}

const SELECT_COLS = 'id, started_at, ended_at, duration_min'

export function createSessionsDao(handle: DbHandle): SessionsDao {
  const { raw } = handle

  const insert = raw.prepare('INSERT INTO sessions (id, started_at) VALUES (?, ?)')
  const selectOne = raw.prepare(`SELECT ${SELECT_COLS} FROM sessions WHERE id = ?`)
  const selectAll = raw.prepare(`SELECT ${SELECT_COLS} FROM sessions ORDER BY started_at DESC`)
  const updateEnd = raw.prepare('UPDATE sessions SET ended_at = ?, duration_min = ? WHERE id = ?')
  const selectStartedAt = raw.prepare('SELECT started_at FROM sessions WHERE id = ?')

  function computeDurationMin(id: string, endedAt: string): number {
    const row = selectStartedAt.get(id) as { started_at: string } | undefined
    if (!row) return 0
    const startMs = Date.parse(row.started_at)
    const endMs = Date.parse(endedAt)
    return Math.max(0, Math.floor((endMs - startMs) / 60_000))
  }

  return {
    create(input: CreateSessionInput = {}) {
      const id = input.id ?? randomUUID()
      const startedAt = input.startedAt ?? new Date().toISOString()
      insert.run(id, startedAt)
      return { id, started_at: startedAt, ended_at: null, duration_min: null }
    },
    get(id: string) {
      return (selectOne.get(id) as Session | undefined) ?? null
    },
    list() {
      return selectAll.all() as Session[]
    },
    markEnded(id: string, opts: MarkEndedInput = {}) {
      const endedAt = opts.endedAt ?? new Date().toISOString()
      const durationMin = opts.durationMin ?? computeDurationMin(id, endedAt)
      updateEnd.run(endedAt, durationMin, id)
      return { id, started_at: '', ended_at: endedAt, duration_min: durationMin }
    },
  }
}
