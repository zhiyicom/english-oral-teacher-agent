import { type SystemPrompt, buildSystemString } from '../prompts/loader.js'
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
 */
export function buildFinalSystem(
  systemPrompt: SystemPrompt,
  state: SessionState,
  lastReview: LastReview | null = null,
  activeTopics: TopicStat[] = [],
): string {
  return [
    buildSystemString(systemPrompt),
    '',
    buildSystemContext(state, lastReview, activeTopics),
  ].join('\n')
}
