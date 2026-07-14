import type { Topic } from '../storage/topics.js'

export interface TopicMatch {
  topic: string
  jaccard: number
  shared: string[]
}

/**
 * Normalize a keyword for matching: lowercase + replace spaces/special chars
 * with underscores. Summarizer outputs natural-English phrases ("delta force",
 * "harry potter") while topic library keywords use underscores ("delta_force",
 * "harry_potter"). This bridge eliminates the format gap.
 */
function norm(s: string): string {
  return s.toLowerCase().replace(/[\s\-]+/g, '_')
}

/**
 * Jaccard similarity between two keyword arrays.
 * - case-insensitive
 * - spaces ↔ underscores normalized
 * - empty input → 0.0
 * - identical sets → 1.0
 * - disjoint sets → 0.0
 */
export function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const setA = new Set(a.map(norm))
  const setB = new Set(b.map(norm))
  let intersection = 0
  for (const x of setA) if (setB.has(x)) intersection++
  const union = setA.size + setB.size - intersection
  return union === 0 ? 0 : intersection / union
}

/**
 * Match a session's keywords against the topic library.
 *
 * v1.1.0 §A — keywords are normalized before comparison (spaces → underscores,
 * lowercased) so summarizer output ("delta force") matches topic-library
 * keywords ("delta_force").
 *
 * v1.1.0 §C — returns ALL matches above threshold (sorted by score descending)
 * instead of just the single best. Multi-topic sessions no longer get under-counted.
 *
 * @returns TopicMatch[] sorted by jaccard score descending. Empty array when
 *   no keyword is shared or all scores are below threshold.
 */
export function matchTopic(
  sessionKeywords: string[],
  topics: Topic[],
  threshold = 0.1,
): TopicMatch[] {
  if (sessionKeywords.length === 0) return []
  const normSession = sessionKeywords.map(norm)
  const results: TopicMatch[] = []
  for (const t of topics) {
    const normTopicKw = t.keywords.map(norm)
    const shared = t.keywords.filter((k) => normSession.includes(norm(k)))
    if (shared.length === 0) continue
    const jScore = jaccard(normSession, normTopicKw)
    const countScore = shared.length / Math.max(sessionKeywords.length, 1)
    const score = Math.max(jScore, countScore)
    if (score < threshold) continue
    results.push({ topic: t.name, jaccard: score, shared })
  }
  results.sort((a, b) => b.jaccard - a.jaccard)
  return results
}
