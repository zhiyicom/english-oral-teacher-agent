import { randomUUID } from 'node:crypto'
import type { PhaseTransition } from '../agent/state-machine.js'
import { bufferToF32, f32ToBuffer } from '../memory/vector-store.js'
import type { DbHandle } from './db.js'

export interface Session {
  id: string
  started_at: string
  ended_at: string | null
  duration_min: number | null
  phase_history: string | null
  summary: string | null
  keywords: string | null
}

/**
 * Projection used by cross-session semantic retrieval (v0.7.2). Returned only
 * for sessions that have both a summary and an embedding — partial rows are
 * excluded by listWithEmbeddings.
 */
export interface SessionWithEmbedding {
  id: string
  startedAt: string
  summary: string
  keywords: string[]
  embedding: Float32Array
}

export interface CreateSessionInput {
  id?: string
  startedAt?: string
}

export interface MarkEndedInput {
  endedAt?: string
  durationMin?: number
  phaseHistory?: PhaseTransition[]
  reason?: string
  summary?: string
  keywords?: string[]
}

export interface SessionsDao {
  create(input?: CreateSessionInput): Session
  get(id: string): Session | null
  list(): Session[]
  markEnded(id: string, opts?: MarkEndedInput): Session
  setEmbedding(id: string, vec: Float32Array): void
  listWithEmbeddings(): SessionWithEmbedding[]
}

const SELECT_COLS = 'id, started_at, ended_at, duration_min, phase_history, summary, keywords'

export function createSessionsDao(handle: DbHandle): SessionsDao {
  const { raw } = handle

  const insert = raw.prepare('INSERT INTO sessions (id, started_at) VALUES (?, ?)')
  const selectOne = raw.prepare(`SELECT ${SELECT_COLS} FROM sessions WHERE id = ?`)
  const selectAll = raw.prepare(`SELECT ${SELECT_COLS} FROM sessions ORDER BY started_at DESC`)
  const selectStartedAt = raw.prepare('SELECT started_at FROM sessions WHERE id = ?')
  const updateEnd = raw.prepare(
    'UPDATE sessions SET ended_at = ?, duration_min = ?, phase_history = COALESCE(?, phase_history), summary = COALESCE(?, summary), keywords = COALESCE(?, keywords) WHERE id = ?',
  )
  const selectAfterUpdate = raw.prepare(`SELECT ${SELECT_COLS} FROM sessions WHERE id = ?`)
  const updateEmbedding = raw.prepare('UPDATE sessions SET embedding = ? WHERE id = ?')
  const selectWithEmbeddings = raw.prepare(
    `SELECT id, started_at, summary, keywords, embedding
     FROM sessions
     WHERE embedding IS NOT NULL AND summary IS NOT NULL
     ORDER BY started_at DESC`,
  )

  function computeDurationMin(id: string, endedAt: string): number {
    const row = selectStartedAt.get(id) as { started_at: string } | undefined
    if (!row) return 0
    const startMs = Date.parse(row.started_at)
    const endMs = Date.parse(endedAt)
    return Math.max(0, Math.floor((endMs - startMs) / 60_000))
  }

  function serializePhaseHistory(history: PhaseTransition[] | undefined): string | null {
    if (!history) return null
    return JSON.stringify(history)
  }

  function serializeKeywords(keywords: string[] | undefined): string | null {
    if (!keywords) return null
    return JSON.stringify(keywords)
  }

  return {
    create(input: CreateSessionInput = {}) {
      const id = input.id ?? randomUUID()
      const startedAt = input.startedAt ?? new Date().toISOString()
      insert.run(id, startedAt)
      return {
        id,
        started_at: startedAt,
        ended_at: null,
        duration_min: null,
        phase_history: null,
        summary: null,
        keywords: null,
      }
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
      const phaseHistoryJson = serializePhaseHistory(opts.phaseHistory)
      const keywordsJson = serializeKeywords(opts.keywords)
      updateEnd.run(endedAt, durationMin, phaseHistoryJson, opts.summary ?? null, keywordsJson, id)
      const after = selectAfterUpdate.get(id) as Session | undefined
      if (!after) {
        return {
          id,
          started_at: '',
          ended_at: endedAt,
          duration_min: durationMin,
          phase_history: phaseHistoryJson,
          summary: opts.summary ?? null,
          keywords: keywordsJson,
        }
      }
      return after
    },
    setEmbedding(id: string, vec: Float32Array): void {
      updateEmbedding.run(f32ToBuffer(vec), id)
    },
    listWithEmbeddings(): SessionWithEmbedding[] {
      const rows = selectWithEmbeddings.all() as Array<{
        id: string
        started_at: string
        summary: string
        keywords: string | null
        embedding: Buffer
      }>
      return rows.map((r) => ({
        id: r.id,
        startedAt: r.started_at,
        summary: r.summary,
        keywords: r.keywords ? (JSON.parse(r.keywords) as string[]) : [],
        embedding: bufferToF32(r.embedding),
      }))
    },
  }
}
