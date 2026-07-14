// src/agent/topic-recorder.ts
// v1.0.7 §11 — write-on-selection: persist the topics that were actually
// adopted during a session (vs. the v1.0.6 approach which inferred topics
// from a noisy summary-keyword match). Shared between the web server
// (src/server.ts) and the CLI (src/cli.ts) so the END pipeline stays
// consistent across both transports.

import type { KeywordHitsDao, Topic, TopicsDao, TopicStatsDao } from '../storage/index.js'
import { matchTopic } from './topic-matcher.js'

export interface AdoptedTopic {
  suggestedKeyword: string
  source: 'auto' | 'llm'
  // v1.0.9 §1.4 — write-on-adoption: count of normal conversation turns
  // where `isTurnOnTopic` returned true for this topic's keywords/description.
  // The session-end write only happens when this meets ADOPTION_MIN_TURNS,
  // so `topic_stats.discussion_count` reflects "really discussed" not
  // "selected by topic_select". Decoupled from keyword_hits.hit_count
  // (cross-session accumulator driven by `suggestedKeyword` upserts).
  onTopicTurns: number
  // v1.0.9 §1.4 — captured at selection time so turn.ts can call
  // `isTurnOnTopic` against this entry without re-reading the topics table.
  keywords: string[]
  description: string | null
}

export type AdoptedTopicsMap = Map<string, AdoptedTopic>

export interface RecordContext {
  sessionId: string
  now: Date
}

// v1.0.9 §1.4 — adoption threshold. "Injected topic must have been
// genuinely engaged with for at least this many turns before it counts."
// N=2 is the smallest value that distinguishes "ignored/single-word reply"
// from "actually discussed" without over-penalizing short sessions.
export const ADOPTION_MIN_TURNS = 2

/**
 * Persist the session's adopted topics and return the slug list to write
 * into `sessions.topics_used`.
 *
 * v1.0.9 §1.4 — write-on-adoption: a topic only counts toward
 * `topic_stats` / `keyword_hits` when its `onTopicTurns` ≥
 * ADOPTION_MIN_TURNS. Topics below the threshold are dropped from
 * `topics_used` so the ledger reflects real discussion.
 *
 * Fallback chain (preserved from v1.0.7 §11):
 * - If at least one adopted topic meets the threshold → write those.
 * - If all adopted topics are below threshold → fall back to
 *   `matchTopic(summaryKeywords, topics)` for best-effort bookkeeping.
 *   Returns `[]` when even the fallback finds nothing.
 *
 * Always returns an array (possibly empty) — never throws on the happy
 * path. Topic recording is best-effort; a DB error is surfaced to the
 * caller via try/catch at the call site (matching the v1.0.6 contract).
 */
export function recordAdoptedTopics(
  adopted: AdoptedTopicsMap,
  fallbackKeywords: string[],
  ctx: RecordContext,
  deps: {
    topics: Topic[]
    topicStats: TopicStatsDao
    keywordHits: KeywordHitsDao
    topicsDao: TopicsDao
  },
): string[] {
  // v1.1.0 §D — ledger + fallback merge. Both paths run; dedup by slug
  // so multi-topic sessions get full credit regardless of whether the
  // LLM called topic_select for each transition.
  const writtenSlugs = new Set<string>()

  // 1. Ledger: write-on-selection (Hook A/B). Only topics with enough
  //    genuine discussion turns count toward adoption.
  if (adopted.size > 0) {
    for (const [slug, info] of adopted) {
      if (info.onTopicTurns < ADOPTION_MIN_TURNS) continue
      deps.topicStats.incrementAndUpdate(slug, ctx.now)
      if (info.suggestedKeyword) {
        deps.keywordHits.upsertMany(slug, [info.suggestedKeyword], ctx.now)
      }
      writtenSlugs.add(slug)
    }
  }

  // 2. Fallback: summary-keyword matchTopic against the topic library.
  //    Skips slugs already covered by the ledger to avoid double-counting.
  const matches = matchTopic(fallbackKeywords, deps.topics)
  for (const m of matches) {
    if (writtenSlugs.has(m.topic)) continue
    deps.topicStats.incrementAndUpdate(m.topic, ctx.now)
    deps.keywordHits.upsertMany(m.topic, [m.shared[0]!], ctx.now)
    writtenSlugs.add(m.topic)
  }

  return [...writtenSlugs]
}