import type { Topic, TopicStat } from '../storage/topics.js'

/**
 * v0.7.6 D1-D4 — Topic selection engine (PRD §3.5.3 + §5.1).
 *
 * Pure functions, no I/O, no DB. Picks a topic from the library using:
 *   D1: hard exclude  — drop topics discussed in the last `excludeDays` days
 *   D2: soft preference — sort remaining by count ascending (less-discussed first)
 *   D3: interest boost — count of topic.keywords ∩ student.interests
 *   D4: weighted random — small noise (±NOISE_RANGE) so the same pool doesn't
 *       always pick the same winner; ties broken by name ASC.
 *
 * The CLI uses this in a `topic_select` tool the LLM can call to pick a
 * new conversation topic mid-session.
 */

export interface TopicCandidate {
  topic: Topic
  count: number
  interest: number
  score: number
}

/** D1 — hard exclude. Keep topics whose lastDiscussedAt is older than cutoff, or never discussed. */
export function filterHardExclude(
  topics: Topic[],
  stats: TopicStat[],
  excludeDays: number,
  now: Date,
): Topic[] {
  const cutoff = now.getTime() - excludeDays * 86_400_000
  return topics.filter((t) => {
    const stat = stats.find((s) => s.topic === t.name)
    if (!stat || !stat.lastDiscussedAt) return true
    return Date.parse(stat.lastDiscussedAt) < cutoff
  })
}

/** D2 — sort by count ascending. Stable: alphabetical tiebreak. */
export function sortByCountAsc(topics: Topic[], stats: TopicStat[]): Topic[] {
  return [...topics].sort((a, b) => {
    const ca = stats.find((s) => s.topic === a.name)?.discussionCount ?? 0
    const cb = stats.find((s) => s.topic === b.name)?.discussionCount ?? 0
    if (ca !== cb) return ca - cb
    return a.name.localeCompare(b.name)
  })
}

/** D3 — case-insensitive overlap count between topic.keywords and interests. */
export function computeInterest(topic: Topic, interests: readonly string[]): number {
  if (interests.length === 0) return 0
  const norm = new Set(interests.map((s) => s.toLowerCase()))
  return topic.keywords.filter((k) => norm.has(k.toLowerCase())).length
}

const COUNT_WEIGHT = 0.1
const INTEREST_WEIGHT = 0.5
const NOISE_RANGE = 0.2

/**
 * Top-level — D1+D2+D3+D4 in one call.
 * Returns null when the hard-exclude filter removes every topic (e.g. all
 * topics have been discussed within excludeDays).
 */
export function selectTopic(opts: {
  topics: Topic[]
  stats: TopicStat[]
  interests: readonly string[]
  excludeDays?: number
  now?: Date
  rng?: () => number
}): Topic | null {
  const excludeDays = opts.excludeDays ?? 30
  const now = opts.now ?? new Date()
  const rng = opts.rng ?? Math.random

  let pool = filterHardExclude(opts.topics, opts.stats, excludeDays, now)
  if (pool.length === 0) return null

  pool = sortByCountAsc(pool, opts.stats)

  const scored: TopicCandidate[] = pool.map((t) => {
    const stat = opts.stats.find((s) => s.topic === t.name) ?? null
    const count = stat?.discussionCount ?? 0
    const interest = computeInterest(t, opts.interests)
    const noise = (rng() * 2 - 1) * NOISE_RANGE
    return {
      topic: t,
      count,
      interest,
      score: -count * COUNT_WEIGHT + interest * INTEREST_WEIGHT + noise,
    }
  })

  scored.sort((a, b) => b.score - a.score)
  return scored[0]?.topic ?? null
}
