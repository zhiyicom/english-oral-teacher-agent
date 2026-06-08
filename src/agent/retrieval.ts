import type { DbHandle } from '../storage/db.js'

export interface LastReview {
  sessionId: string
  startedAt: string
  endedAt: string | null
  durationMin: number | null
  summary: string
  keywords: string[]
  /** Integer days between the session's startedAt and `now`. Floor of elapsed ms / 86_400_000. */
  daysAgo: number
}

interface SessionRow {
  id: string
  started_at: string
  ended_at: string | null
  duration_min: number | null
  summary: string | null
  keywords: string | null
}

/**
 * Load the most recent session that has a non-null summary.
 *
 * - Pure SQL: `ORDER BY started_at DESC LIMIT 1` with `WHERE summary IS NOT NULL`.
 * - `daysAgo` is computed at call time against `now` (default = new Date()), so the
 *   caller controls "what is now" for testing.
 * - Returns null when no session has a summary yet (e.g. fresh DB or v0.3 sessions).
 */
export function loadLastReview(handle: DbHandle, now: Date = new Date()): LastReview | null {
  const row = handle.raw
    .prepare(
      `SELECT id, started_at, ended_at, duration_min, summary, keywords
       FROM sessions
       WHERE summary IS NOT NULL
       ORDER BY started_at DESC
       LIMIT 1`,
    )
    .get() as SessionRow | undefined

  if (!row || !row.summary) return null

  const startMs = Date.parse(row.started_at)
  const daysAgo = Math.max(0, Math.floor((now.getTime() - startMs) / 86_400_000))

  return {
    sessionId: row.id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationMin: row.duration_min,
    summary: row.summary,
    keywords: row.keywords ? (JSON.parse(row.keywords) as string[]) : [],
    daysAgo,
  }
}
