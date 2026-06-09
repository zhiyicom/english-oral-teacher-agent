/**
 * Cross-session semantic retrieval. v0.7.2.
 *
 * Pure function: takes a candidate set + query vector, returns the top-K most
 * similar candidates by cosine similarity. No DB/IO — the caller is responsible
 * for fetching candidates (via SessionsDao.listWithEmbeddings) so the memory
 * module never imports storage.
 *
 * Brute-force scan is fine at our scale: 1000 sessions × 384-dim = ~384K
 * mul-adds, sub-millisecond on any modern laptop. Revisit only if N > 10K.
 */

import type { SessionWithEmbedding } from '../storage/sessions.js'
import { cosineSimilarity } from './vector-store.js'

export interface RelevantSession {
  sessionId: string
  startedAt: string
  summary: string
  keywords: string[]
  similarity: number
  daysAgo: number
}

export interface RetrieveRelevantOpts {
  candidates: SessionWithEmbedding[]
  queryVec: Float32Array
  topK: number
  /** Drop this session from results (e.g. the most-recent session whose
   *  keywords seeded the query — it's already in the Last session block). */
  excludeSessionId?: string
  /** Override clock for tests. Default = new Date(). */
  now?: Date
}

const MS_PER_DAY = 86_400_000

export function retrieveRelevant(opts: RetrieveRelevantOpts): RelevantSession[] {
  const now = opts.now ?? new Date()
  const filtered = opts.excludeSessionId
    ? opts.candidates.filter((c) => c.id !== opts.excludeSessionId)
    : opts.candidates

  const scored: RelevantSession[] = filtered.map((c) => ({
    sessionId: c.id,
    startedAt: c.startedAt,
    summary: c.summary,
    keywords: c.keywords,
    similarity: cosineSimilarity(opts.queryVec, c.embedding),
    daysAgo: Math.max(0, Math.floor((now.getTime() - Date.parse(c.startedAt)) / MS_PER_DAY)),
  }))

  scored.sort((a, b) => b.similarity - a.similarity)
  return scored.slice(0, opts.topK)
}
