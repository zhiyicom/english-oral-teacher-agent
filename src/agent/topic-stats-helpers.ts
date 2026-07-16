import type { TopicStat } from '../storage/topics.js'

/**
 * v1.1.2 §3.2 — return up to `limit` most-recently-discussed topics with
 * lastDiscussedAt within the last `days` days. Pure: no I/O, no DB.
 *
 * Backlog T13 (v1.1.2-scope.md §6): future sprint may inject this into
 * the blocked-branch hint to tell the LLM what NOT to improvise on.
 * Sorted by lastDiscussedAt DESC.
 */
export function pickRecentDiscussed(
  stats: readonly TopicStat[],
  days: number,
  now: Date = new Date(),
  limit: number = 3,
): TopicStat[] {
  const cutoff = now.getTime() - days * 86_400_000
  const filtered = [...stats].filter(
    (s): s is TopicStat & { lastDiscussedAt: string } =>
      typeof s.lastDiscussedAt === 'string' && Date.parse(s.lastDiscussedAt) >= cutoff,
  )
  return filtered
    .sort((a, b) => Date.parse(b.lastDiscussedAt) - Date.parse(a.lastDiscussedAt))
    .slice(0, limit)
}
