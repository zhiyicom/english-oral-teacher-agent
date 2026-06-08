import { type SystemPrompt, buildSystemString } from '../prompts/loader.js'
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
 */
export function buildFinalSystem(
  systemPrompt: SystemPrompt,
  state: SessionState,
  lastReview: LastReview | null = null,
): string {
  return [buildSystemString(systemPrompt), '', buildSystemContext(state, lastReview)].join('\n')
}
