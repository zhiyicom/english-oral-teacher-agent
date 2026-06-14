import type { Topic } from '../storage/topics.js'

export interface TopicMatch {
  topic: string
  jaccard: number
  shared: string[]
}

/**
 * Jaccard similarity between two keyword arrays.
 * - case-insensitive
 * - empty input → 0.0
 * - identical sets → 1.0
 * - disjoint sets → 0.0
 */
export function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const setA = new Set(a.map((s) => s.toLowerCase()))
  const setB = new Set(b.map((s) => s.toLowerCase()))
  let intersection = 0
  for (const x of setA) if (setB.has(x)) intersection++
  const union = setA.size + setB.size - intersection
  return union === 0 ? 0 : intersection / union
}

/**
 * Match a session's keywords against the topic library using Jaccard.
 * - empty session keywords → null
 * - no topic above threshold → null
 * - on tie (two topics same Jaccard), pick the lexicographically smaller name
 *   so the result is deterministic
 */
export function matchTopic(
  sessionKeywords: string[],
  topics: Topic[],
  threshold = 0.1,
): TopicMatch | null {
  if (sessionKeywords.length === 0) return null
  const normSession = sessionKeywords.map((s) => s.toLowerCase())
  let best: TopicMatch | null = null
  for (const t of topics) {
    const shared = t.keywords.filter((k) => normSession.includes(k.toLowerCase()))
    if (shared.length === 0) continue
    // Two scoring axes: Jaccard similarity + simple keyword count.
    // A single shared keyword is often meaningful (e.g. "football" → sports).
    const jScore = jaccard(normSession, t.keywords)
    const countScore = shared.length / Math.max(sessionKeywords.length, 1)
    const score = Math.max(jScore, countScore)
    if (score < threshold) continue
    if (best === null || score > best.jaccard || (score === best.jaccard && t.name < best.topic)) {
      best = { topic: t.name, jaccard: score, shared }
    }
  }
  return best
}
