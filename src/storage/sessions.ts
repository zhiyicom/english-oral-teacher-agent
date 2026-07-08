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
  topics_used: string[] | null
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
  // v1.0.7 §11 — slugs actually discussed in the session, derived from the
  // adopted-topics ledger (write-on-selection). Empty array when no topic was
  // ever adopted (fallback path or crashed before MAIN_ACTIVITY).
  topicsUsed?: string[]
}

export interface SessionsDao {
  create(input?: CreateSessionInput): Session
  get(id: string): Session | null
  list(): Session[]
  markEnded(id: string, opts?: MarkEndedInput): Session
  setEmbedding(id: string, vec: Float32Array): void
  delete(id: string): void
  listWithEmbeddings(): SessionWithEmbedding[]
}

const SELECT_COLS = 'id, started_at, ended_at, duration_min, phase_history, summary, keywords, topics_used'

export function createSessionsDao(handle: DbHandle): SessionsDao {
  const { raw } = handle

  // v1.0.7 §11 — one-time idempotent patch: historical rows have topics_used = NULL.
  // Running this on every DAO construction is safe (UPDATE … IS NULL is a no-op when
  // already set) and avoids needing a separate migration runner.
  raw.exec("UPDATE sessions SET topics_used = '[]' WHERE topics_used IS NULL")

  const insert = raw.prepare('INSERT INTO sessions (id, started_at) VALUES (?, ?)')
  const selectOne = raw.prepare(`SELECT ${SELECT_COLS} FROM sessions WHERE id = ?`)
  const selectAll = raw.prepare(`SELECT ${SELECT_COLS} FROM sessions ORDER BY started_at DESC`)
  const selectStartedAt = raw.prepare('SELECT started_at FROM sessions WHERE id = ?')
  const updateEnd = raw.prepare(
    'UPDATE sessions SET ended_at = ?, duration_min = ?, phase_history = COALESCE(?, phase_history), summary = COALESCE(?, summary), keywords = COALESCE(?, keywords), topics_used = COALESCE(?, topics_used) WHERE id = ?',
  )
  const selectAfterUpdate = raw.prepare(`SELECT ${SELECT_COLS} FROM sessions WHERE id = ?`)
  const updateEmbedding = raw.prepare('UPDATE sessions SET embedding = ? WHERE id = ?')
  const deleteOne = raw.prepare('DELETE FROM sessions WHERE id = ?')
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

  // v1.0.7 §11 — returns null when caller did not provide topicsUsed so
  // the SQL COALESCE preserves any prior value (parity with summary /
  // keywords columns). When provided, returns a JSON array string.
  function serializeTopicsUsed(topics: string[] | undefined): string | null {
    if (topics === undefined) return null
    return JSON.stringify(topics)
  }

  function parseTopicsUsed(raw: string | null): string[] {
    if (!raw) return []
    try {
      const parsed = JSON.parse(raw) as unknown
      return Array.isArray(parsed) ? (parsed as string[]) : []
    } catch {
      return []
    }
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
        topics_used: [],
      }
    },
    get(id: string) {
      const row = selectOne.get(id) as (Session & { topics_used: string | null }) | undefined
      if (!row) return null
      return { ...row, topics_used: parseTopicsUsed(row.topics_used) }
    },
    list() {
      const rows = selectAll.all() as Array<Session & { topics_used: string | null }>
      return rows.map((r) => ({ ...r, topics_used: parseTopicsUsed(r.topics_used) }))
    },
    markEnded(id: string, opts: MarkEndedInput = {}) {
      const endedAt = opts.endedAt ?? new Date().toISOString()
      const durationMin = opts.durationMin ?? computeDurationMin(id, endedAt)
      const phaseHistoryJson = serializePhaseHistory(opts.phaseHistory)
      const keywordsJson = serializeKeywords(opts.keywords)
      const topicsUsedJson = serializeTopicsUsed(opts.topicsUsed)
      updateEnd.run(
        endedAt,
        durationMin,
        phaseHistoryJson,
        opts.summary ?? null,
        keywordsJson,
        topicsUsedJson,
        id,
      )
      const after = selectAfterUpdate.get(id) as
        | (Session & { topics_used: string | null })
        | undefined
      if (!after) {
        return {
          id,
          started_at: '',
          ended_at: endedAt,
          duration_min: durationMin,
          phase_history: phaseHistoryJson,
          summary: opts.summary ?? null,
          keywords: keywordsJson,
          topics_used: parseTopicsUsed(topicsUsedJson),
        }
      }
      return { ...after, topics_used: parseTopicsUsed(after.topics_used) }
    },
    setEmbedding(id: string, vec: Float32Array): void {
      updateEmbedding.run(f32ToBuffer(vec), id)
    },
    delete(id: string): void {
      // ON DELETE CASCADE cleans up messages + mistakes
      deleteOne.run(id)
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
