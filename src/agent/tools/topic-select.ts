import { z } from 'zod'
import type { Topic, TopicStat } from '../../storage/topics.js'
import type { Tool } from '../tool-registry.js'
import { selectTopic } from '../topic-engine.js'

/**
 * v0.7.6 D5 — `topic_select` tool. LLM calls this when it wants a fresh
 * topic for the current conversation phase.
 *
 * Pure computation: schema → call selectTopic() → return slug+title+est_minutes
 * (or an error). No DB writes. The CLI does the A+B 2nd-call so the LLM can
 * read back the result and produce the student-facing reply.
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
}

const DESCRIPTION =
  'Pick a topic for the current conversation phase. Uses: ' +
  '(1) hard exclude topics discussed in the last N days, ' +
  '(2) soft preference for topics with low discussion count, ' +
  '(3) interest boost if student.interests matches, ' +
  '(4) weighted random selection to avoid deterministic picks. ' +
  'Returns the topic slug, title, and estimated minutes.'

// est_minutes is hardcoded in v0.7.6 (Topic schema has no such field).
// F7 topic library will add it to Topic frontmatter; at that point the
// return type can be widened to use topic.est_minutes. v0.7.6 keeps
// the contract stable at 15 min so the LLM gets a consistent shape.
const DEFAULT_EST_MINUTES = 15

export function createTopicSelectTool(opts: {
  topics: Topic[]
  stats: TopicStat[]
  interests: string[]
  rng?: () => number
}): Tool {
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
        excludeDays: parsed.exclude_recent_days,
        rng: opts.rng,
      })
      if (!winner) {
        return { error: 'No topics available after hard exclude' }
      }
      return { slug: winner.name, title: winner.name, est_minutes: DEFAULT_EST_MINUTES }
    },
  }
}
