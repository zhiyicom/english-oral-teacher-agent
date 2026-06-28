import { z } from 'zod'
import type { KeywordHit, Topic, TopicStat } from '../../storage/topics.js'
import type { Tool } from '../tool-registry.js'
import { selectTopic } from '../topic-engine.js'

/**
 * v0.7.6 D5 — `topic_select` tool. LLM calls this when it wants a fresh
 * topic for the current conversation phase.
 * v1.0.2 — return value adds `suggested_keyword` (lowest-hit keyword in
 * the chosen topic) so the LLM has a soft hint on the under-used angle.
 *
 * Pure computation: schema → call selectTopic() → return slug+title+est_minutes
 * (+ suggested_keyword) or an error. No DB writes. The CLI does the A+B
 * 2nd-call so the LLM can read back the result and produce the student-facing
 * reply.
 *
 * Phase is accepted as a hint for future extension (e.g. MAIN_ACTIVITY might
 * prefer higher-est_minutes topics); v0.7.6 ignores it — the engine is
 * phase-agnostic. The arg exists in the schema so the LLM can pass it
 * without surprises, and so the future F7 topic library can route by phase
 * without a schema break.
 */
export const TopicSelectArgsSchema = z.object({
  phase: z.enum(['WARM_UP', 'MAIN_ACTIVITY', 'WRAP_UP', 'END']).default('WARM_UP'),
  exclude_recent_days: z.number().int().min(0).max(365).default(30),
})

export type TopicSelectArgs = z.infer<typeof TopicSelectArgsSchema>

export interface TopicSelectResult {
  slug: string
  title: string
  est_minutes: number
  /**
   * v1.0.2 — soft hint for an under-used keyword inside the chosen topic.
   * Computed as the topic's keyword with the lowest hit_count (missing/0
   * ranks first; ties broken by alphabetical order). Optional to keep
   * backwards compatibility with LLM that ignore unknown fields.
   */
  suggested_keyword?: string
}

// v1.0.3 §1.3 — D3 (interest boost) is permanently disabled in this tool.
// Interest matching is handled by the WARM_UP phase prompt, not by the
// selection algorithm. Description deliberately does NOT advertise interest
// boost so the LLM doesn't waste turns trying to influence selection via
// user.interests (which is read-only context for the WARM_UP hook anyway).
const DESCRIPTION =
  'Pick the next topic based on call-count signals: ' +
  '(1) hard exclude topics discussed in the last N days, ' +
  '(2) soft preference for topics with low discussion count, ' +
  '(3) keyword freshness: prefer topics whose inner keywords have been hit less, ' +
  '(4) weighted random selection to avoid deterministic picks. ' +
  'Interest matching happens in WARM_UP phase via prompt — this tool does NOT consider user.interests. ' +
  'Returns the topic slug, title, estimated minutes, and a suggested_keyword ' +
  'to use as the opening angle.'

// est_minutes is hardcoded in v0.7.6 (Topic schema has no such field).
// F7 topic library will add it to Topic frontmatter; at that point the
// return type can be widened to use topic.est_minutes. v0.7.6 keeps
// the contract stable at 15 min so the LLM gets a consistent shape.
const DEFAULT_EST_MINUTES = 15

/**
 * Pick the keyword inside `topic` with the lowest hit_count.
 * - Missing keywords (not in `keywordStats`) are treated as 0 → rank first.
 * - Alphabetical tiebreak.
 * - Returns null when the topic has no keywords at all.
 */
function pickFreshestKeyword(topic: Topic, keywordStats: KeywordHit[]): string | null {
  if (topic.keywords.length === 0) return null
  const byKeyword = new Map(keywordStats.map((h) => [h.keyword.toLowerCase(), h.hitCount]))
  const ranked = [...topic.keywords].sort((a, b) => {
    const ha = byKeyword.get(a.toLowerCase()) ?? 0
    const hb = byKeyword.get(b.toLowerCase()) ?? 0
    if (ha !== hb) return ha - hb
    return a.localeCompare(b)
  })
  return ranked[0] ?? null
}

export function createTopicSelectTool(opts: {
  topics: Topic[]
  stats: TopicStat[]
  interests: string[]
  keywordStats?: KeywordHit[]
  rng?: () => number
  // v1.0.3 §1.3 — defaults to false (D3 disabled). WARM_UP handles
  // interest matching; this tool only sees call-count signals.
  useInterestBoost?: boolean
}): Tool {
  const keywordStats = opts.keywordStats ?? []
  const useInterestBoost = opts.useInterestBoost ?? false
  return {
    name: 'topic_select',
    description: DESCRIPTION,
    schema: TopicSelectArgsSchema,
    execute(args: unknown): TopicSelectResult | { error: string } {
      const parsed = TopicSelectArgsSchema.parse(args)
      const winner = selectTopic({
        topics: opts.topics,
        stats: opts.stats,
        interests: opts.interests,
        keywordStats,
        excludeDays: parsed.exclude_recent_days,
        rng: opts.rng,
        useInterestBoost,
      })
      if (!winner) {
        return { error: 'No topics available after hard exclude' }
      }
      return {
        slug: winner.name,
        title: winner.name,
        est_minutes: DEFAULT_EST_MINUTES,
        suggested_keyword: pickFreshestKeyword(winner, keywordStats) ?? undefined,
      }
    },
  }
}
