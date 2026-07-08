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
}

export type AdoptedTopicsMap = Map<string, AdoptedTopic>

export interface RecordContext {
  sessionId: string
  now: Date
}

/**
 * Persist the session's adopted topics and return the slug list to write
 * into `sessions.topics_used`.
 *
 * - If `adopted` is non-empty: iterate every (slug, info) pair, call
 *   `topicStats.incrementAndUpdate(slug, now)` and
 *   `keywordHits.upsertMany(slug, [suggestedKeyword], now)` for each.
 *   Slugs are deduped by the caller (the Map's keys are unique), so the
 *   same topic never gets double-counted within one session.
 * - If `adopted` is empty (e.g. session ended before MAIN_ACTIVITY
 *   auto-inject could fire, or the LLM never successfully called
 *   `topic_select`): fall back to `matchTopic(summaryKeywords, topics)`
 *   for best-effort bookkeeping. Returns `[]` when even the fallback
 *   finds nothing — caller should write an empty `topics_used` array.
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
  if (adopted.size > 0) {
    for (const [slug, info] of adopted) {
      deps.topicStats.incrementAndUpdate(slug, ctx.now)
      if (info.suggestedKeyword) {
        deps.keywordHits.upsertMany(slug, [info.suggestedKeyword], ctx.now)
      }
    }
    return [...adopted.keys()]
  }

  const best = matchTopic(fallbackKeywords, deps.topics)
  if (best) {
    deps.topicStats.incrementAndUpdate(best.topic, ctx.now)
    deps.keywordHits.upsertMany(best.topic, best.shared, ctx.now)
    return [best.topic]
  }
  return []
}