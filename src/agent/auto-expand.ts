// src/agent/auto-expand.ts
// v1.1.0 §1.3 — session-end pipeline that grows the topic library when
// the user has opted in via the `auto_expand_topics` settings toggle.
//
// Two-stage strategy (user-confirmed in v1.1.0-scope §1.3):
//   1. MERGE — try to attach the session's unmatched keywords to an
//      existing topic via `matchTopic(threshold=0.05)`. This is a
//      permissive threshold (vs. baseline 0.1) so borderline coverage
//      still extends the right topic. Only `keyword_hits` is bumped;
//      `topic_stats` stays unchanged so we never double-count with
//      `recordAdoptedTopics`.
//   2. CREATE — if no existing topic shares keywords, ask the LLM
//      (extractNewTopicFromKeywords, fail-safe) to propose a new topic.
//      On accept we run topics.create → topicStats.incrementAndUpdate
//      → keywordHits.upsertMany, all with count=1.
//
// All errors are caught locally and logged to stderr; the session-end
// main pipeline is never blocked.

import { extractNewTopicFromKeywords } from './topic-builder.js'
import { matchTopic } from './topic-matcher.js'
import type { Topic, TopicStatsDao, TopicsDao, KeywordHitsDao } from '../storage/index.js'
import type { LLMClient } from '../llm/types.js'

const MERGE_THRESHOLD = 0.05

export interface AutoExpandPrefs {
  /** Master switch — when false the function returns immediately. */
  enabled: boolean
}

export interface AutoExpandDeps {
  topics: Topic[]
  topicStats: TopicStatsDao
  keywordHits: KeywordHitsDao
  topicsDao: TopicsDao
  client: LLMClient
}

export interface AutoExpandContext {
  now: Date
}

/**
 * Try to grow the topic library from a finished session's summary
 * keywords. NEVER throws — any error is logged to stderr and the
 * function returns normally so the session-end main pipeline keeps
 * running.
 */
export async function autoExpandTopicLibrary(
  summaryKeywords: readonly string[],
  adoptedSlugs: readonly string[],
  deps: AutoExpandDeps,
  ctx: AutoExpandContext,
  prefs: AutoExpandPrefs,
): Promise<void> {
  try {
    if (!prefs.enabled) return
    if (summaryKeywords.length === 0) return

    // Step 1: drop keywords that already belong to an adopted topic.
    // recordAdoptedTopics() has already written stats for these topics;
    // we don't want to bump them again via the merge path.
    const adoptedSet = new Set(adoptedSlugs)
    const adoptedKwSet = new Set<string>()
    for (const t of deps.topics) {
      if (!adoptedSet.has(t.name)) continue
      for (const k of t.keywords) adoptedKwSet.add(k.toLowerCase())
    }
    const newKeywords = summaryKeywords.filter(
      (k) => !adoptedKwSet.has(k.toLowerCase()),
    )
    if (newKeywords.length === 0) return

    // Step 2: MERGE — attach to existing topics. v1.1.0 §E traverses all
    // Top-N matches so every matching keyword is absorbed by its best-fit
    // topic. Only keywords that appear in ZERO matches go to CREATE.
    const matches = matchTopic(newKeywords, deps.topics, MERGE_THRESHOLD)
    const mergedKwSet = new Set<string>()
    for (const m of matches) {
      if (m.shared.length === 0) continue
      deps.keywordHits.upsertMany(m.topic, m.shared, ctx.now)
      for (const k of m.shared) mergedKwSet.add(k.toLowerCase())
    }
    if (matches.length > 0) {
      process.stderr.write(
        `[auto-expand] merged into ${matches.length} topic(s): ` +
        matches.map(m => `${m.topic}[${m.shared.join(',')}]`).join('; ') + '\n',
      )
    }

    // Step 3: identify keywords NOT covered by any merge → CREATE candidate.
    const unmerged = newKeywords.filter(
      (k) => !mergedKwSet.has(k.toLowerCase()),
    )
    if (unmerged.length === 0) return

    const proposed = await extractNewTopicFromKeywords(
      unmerged,
      deps.topics.map((t) => t.name),
      deps.client,
    )
    if (!proposed) {
      process.stderr.write('[auto-expand] LLM declined / invalid, skip\n')
      return
    }

    const inserted = deps.topicsDao.create({
      name: proposed.name,
      keywords: proposed.keywords,
      description: proposed.description,
      createdAt: ctx.now.toISOString(),
    })
    if (!inserted) {
      // OR IGNORE skipped a race with the baseline or another session.
      process.stderr.write(`[auto-expand] duplicate name ${proposed.name}, skip\n`)
      return
    }

    deps.topicStats.incrementAndUpdate(proposed.name, ctx.now)
    deps.keywordHits.upsertMany(proposed.name, proposed.keywords, ctx.now)
    process.stderr.write(
      `[auto-expand] created: ${proposed.name} (${proposed.keywords.length} kw)\n`,
    )
  } catch (err) {
    process.stderr.write(
      `[auto-expand] failed: ${(err as Error).message ?? String(err)}\n`,
    )
    // Swallow — session-end main pipeline must not be blocked.
  }
}
