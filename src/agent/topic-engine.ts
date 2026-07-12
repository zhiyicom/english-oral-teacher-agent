import type { KeywordHit, Topic, TopicStat } from '../storage/topics.js'

/**
 * v0.7.6 D1-D4 — Topic selection engine (PRD §3.5.3 + §5.1).
 * v1.0.2 D5 — Keyword-freshness bias: penalize topics whose inner keywords
 *   have already been hit many times. avgKeywordHit per topic = mean of
 *   its keywords' hit_count in `keyword_hits`. Missing (never hit) = 0.
 *
 * Pure functions, no I/O, no DB. Picks a topic from the library using:
 *   D1: hard exclude  — drop topics discussed in the last `excludeDays` days
 *   D2: soft preference — sort remaining by count ascending (less-discussed first)
 *   D3: interest boost — count of topic.keywords ∩ student.interests
 *   D4: weighted random — small noise (±NOISE_RANGE) so the same pool doesn't
 *       always pick the same winner; ties broken by name ASC.
 *   D5 (v1.0.2): keyword freshness — bonus to topics with low avg keyword hits
 *
 * The CLI uses this in a `topic_select` tool the LLM can call to pick a
 * new conversation topic mid-session.
 */

export interface TopicCandidate {
  topic: Topic
  count: number
  interest: number
  avgKeywordHit: number
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

/**
 * D5 (v1.0.2) — mean hit_count across the topic's keywords.
 * - Keywords missing from `keywordStats` are treated as 0 (never hit).
 * - Empty topic.keywords → 0 (no penalty, no bonus).
 * - Returns a non-negative number.
 */
export function avgKeywordHit(topic: Topic, keywordStats: KeywordHit[]): number {
  if (topic.keywords.length === 0) return 0
  const byKeyword = new Map(keywordStats.map((h) => [h.keyword.toLowerCase(), h.hitCount]))
  let sum = 0
  for (const k of topic.keywords) sum += byKeyword.get(k.toLowerCase()) ?? 0
  return sum / topic.keywords.length
}

/**
 * v1.0.9 §1.4 — A turn is "on the topic" when the user message OR the
 * assistant message contains (case-insensitive substring) any of
 * `topic.keywords` ∪ `topic.description`.
 *
 * description (human-readable long form, may be null) is added to the
 * match pool so topics with short keywords still match naturally:
 *   topic `boeing_737`, keywords=["boeing","737","cockpit"],
 *   description="波音 737 驾驶舱"
 *   user "我昨天看了波音 737 的视频" → matches "波音 737 驾驶舱" substring
 *
 * Pure: no I/O, no DB. Caller (turn.ts) tracks per-session
 * `onTopicTurns` and decides adoption at session end.
 */
export function isTurnOnTopic(
  topic: Topic,
  userContent: string,
  assistantContent: string,
): boolean {
  const needles = [
    ...topic.keywords,
    ...(topic.description ? [topic.description] : []),
  ]
    .map((n) => n.toLowerCase().trim())
    .filter((n) => n.length > 0)
  if (needles.length === 0) return false
  const haystack = `${userContent} ${assistantContent}`.toLowerCase()
  return needles.some((needle) => haystack.includes(needle))
}

// v1.0.9 §1.3 — independent contextBoost channel. NOT to be confused with
// the legacy `interest` channel (D3, disabled by v1.0.3 §1.3). Interest
// was "student's long-term interest profile"; contextBoost is "keywords
// from the current session's WARM_UP phase" — a transient hint about
// what was just talked about, used to soften Hook A's random pick into
// something related to the live conversation.
//
// Substring overlap (case-insensitive) of `topic.keywords` with
// `contextKeywords`. Empty `contextKeywords` → 0. Empty topic.keywords → 0.
export function computeContextOverlap(
  topic: Topic,
  contextKeywords: readonly string[],
): number {
  if (contextKeywords.length === 0) return 0
  const norm = new Set(contextKeywords.map((s) => s.toLowerCase()))
  return topic.keywords.filter((k) => norm.has(k.toLowerCase())).length
}

// v1.0.9 §1.3 — chosen so one related keyword beats a single count diff
// (0.1) but a 2-count lead (0.2) still wins. Dedup priority > relevance.
export const CONTEXT_WEIGHT = 0.15

const COUNT_WEIGHT = 0.1
const KEYWORD_WEIGHT = 0.05
const INTEREST_WEIGHT = 0.5
// v1.0.9 §1.2 — peak-to-peak (0.1) sits just above a single count diff (0.1),
// so noise breaks ties without flipping a clear count ordering.
const NOISE_RANGE = 0.05

/**
 * Top-level — D1+D2+D3+D4(+D5) in one call.
 * Returns null when the hard-exclude filter removes every topic (e.g. all
 * topics have been discussed within excludeDays).
 *
 * `keywordStats` is optional; when omitted (legacy callers, tests), D5
 * contributes zero to the score so the v0.7.6 contract is preserved.
 *
 * v1.0.3 §1.3 — `useInterestBoost` defaults to `false`. When false, D3
 * (interest boost) is skipped entirely: interest = 0 regardless of the
 * `interests` argument. This is the v1.0.3 default for both CLI and Server
 * topic_select tool callers — interest matching is handled by WARM_UP phase
 * prompt, not by this algorithm. Pass `useInterestBoost: true` to opt back
 * into D3 (legacy / test paths).
 */
export function selectTopic(opts: {
  topics: Topic[]
  stats: TopicStat[]
  interests: readonly string[]
  keywordStats?: KeywordHit[]
  excludeDays?: number
  now?: Date
  rng?: () => number
  useInterestBoost?: boolean
  // v1.0.9 §1.3 — independent of `interests` (D3, disabled). Soft-boost
  // for topics whose keywords overlap with this session's WARM_UP context.
  // Applied AFTER hard-exclude so dedup priority beats relevance. When
  // omitted, behaves exactly as before (no context boost).
  contextKeywords?: readonly string[]
}): Topic | null {
  const excludeDays = opts.excludeDays ?? 30
  const now = opts.now ?? new Date()
  const rng = opts.rng ?? Math.random
  const keywordStats = opts.keywordStats ?? []
  // v1.0.3 §1.3 — D3 disabled by default. opts.interests is still required
  // in the signature for backwards compat but is only consulted when
  // useInterestBoost === true.
  const useInterestBoost = opts.useInterestBoost ?? false
  // v1.0.9 §1.3 — contextKeywords is purely additive; empty/missing = 0.
  const contextKeywords = opts.contextKeywords ?? []

  let pool = filterHardExclude(opts.topics, opts.stats, excludeDays, now)
  if (pool.length === 0) return null

  pool = sortByCountAsc(pool, opts.stats)

  const scored: TopicCandidate[] = pool.map((t) => {
    const stat = opts.stats.find((s) => s.topic === t.name) ?? null
    const count = stat?.discussionCount ?? 0
    const interest = useInterestBoost ? computeInterest(t, opts.interests) : 0
    const kAvg = avgKeywordHit(t, keywordStats)
    const context = computeContextOverlap(t, contextKeywords)
    const noise = (rng() * 2 - 1) * NOISE_RANGE
    return {
      topic: t,
      count,
      interest,
      avgKeywordHit: kAvg,
      // v1.0.9 §1.3 — `+ context * CONTEXT_WEIGHT`. Independent of D3
      // (interest) so the disabled-by-default interest channel stays dead.
      score:
        -count * COUNT_WEIGHT -
        kAvg * KEYWORD_WEIGHT +
        interest * INTEREST_WEIGHT +
        context * CONTEXT_WEIGHT +
        noise,
    }
  })

  scored.sort((a, b) => b.score - a.score)
  return scored[0]?.topic ?? null
}
