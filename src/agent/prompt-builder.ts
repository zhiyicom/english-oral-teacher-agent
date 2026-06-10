import type { RelevantSession } from '../memory/retrieve-relevant.js'
import { type SystemPrompt, buildSystemString } from '../prompts/loader.js'
import type { Mistake } from '../storage/mistakes.js'
import type { TopicStat } from '../storage/topics.js'
import { buildSystemContext } from './context-injector.js'
import type { LastReview } from './retrieval.js'
import type { SessionState } from './state-machine.js'

/**
 * Compose the final `system` string passed to the LLM.
 *
 * = SOUL + AGENTS + STUDENT + [System Context]
 *
 * v0.5 — `lastReview` is optional. Caller (CLI) passes it only on the first
 * turn of the session, then null afterwards (first-turn-only injection).
 *
 * v0.6 — `activeTopics` is optional. Unlike `lastReview` (first-turn-only),
 * active topics are an aggregate view useful for the whole session, so the
 * caller passes the same value to every turn.
 *
 * v0.7.1 — `recentMistakes` is optional. Same load-once / pass-every-turn
 * pattern as `activeTopics` (see v0.7.1 design §3.2). The CLI loads
 * `mistakes.getRecent(5)` at startup and threads the same list to every turn.
 *
 * v0.7.2 — `relevantPast` is optional. Semantic top-K retrieval seeded by the
 * previous session's keywords. CLI passes this ONLY on the first turn (same
 * first-turn-only pattern as `lastReview` — after the conversation actually
 * starts, the seed becomes stale and the tokens are wasted).
 *
 * v0.7.5 — kept as a thin wrapper for backwards compat. New callers should
 * use `buildFinalSystemSplit` to get the static/dynamic split needed for
 * Anthropic prompt caching.
 */
export function buildFinalSystem(
  systemPrompt: SystemPrompt,
  state: SessionState,
  lastReview: LastReview | null = null,
  activeTopics: TopicStat[] = [],
  recentMistakes: Mistake[] = [],
  relevantPast: RelevantSession[] = [],
): string {
  return [
    buildSystemString(systemPrompt),
    '',
    buildSystemContext(state, lastReview, activeTopics, recentMistakes, relevantPast),
  ].join('\n')
}

/**
 * v0.7.5 — split the final system prompt into the two segments that
 * Anthropic's prompt cache can reuse independently:
 *
 *   - `static`  = SOUL + AGENTS + USER  (constant for the whole session;
 *                safe to mark with `cache_control: ephemeral` so subsequent
 *                turns hit the cache for ~90% cost reduction on this prefix).
 *   - `dynamic` = [System Context]        (changes every turn: phase,
 *                lastReview, active topics, recent mistakes, relevant
 *                past). The CLI also appends an empty trailing newline
 *                so the two segments join with the same single-blank
 *                separator that the legacy `buildFinalSystem` used.
 *
 * Returned as `{ static, dynamic }` so the caller can pass them to the
 * Anthropic client as separate `system` text blocks (the SDK concatenates
 * them in the order given). Old `buildFinalSystem` callers are unaffected.
 */
export function buildFinalSystemSplit(
  systemPrompt: SystemPrompt,
  state: SessionState,
  lastReview: LastReview | null = null,
  activeTopics: TopicStat[] = [],
  recentMistakes: Mistake[] = [],
  relevantPast: RelevantSession[] = [],
): { static: string; dynamic: string } {
  return {
    static: buildSystemString(systemPrompt),
    dynamic: buildSystemContext(state, lastReview, activeTopics, recentMistakes, relevantPast),
  }
}
