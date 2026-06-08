import type { LastReview } from './retrieval.js'
import type { SessionState } from './state-machine.js'

/**
 * Build the `[System Context]` block that gets appended to the LLM system prompt.
 *
 * v0.5 — adds an optional "Last session" segment when a `lastReview` is provided.
 * The segment is only added when `lastReview` is non-null; the caller (CLI) is
 * responsible for passing it ONLY on the first turn of the session (first-turn-only
 * injection per v0.5 design §2.5).
 */
export function buildSystemContext(
  state: SessionState,
  lastReview: LastReview | null = null,
): string {
  const lastTransitionAgo = Math.max(0, state.elapsedMin - state.lastTransitionAt)
  const lines = [
    '[System Context]',
    `- Phase: ${state.phase}`,
    `- Elapsed: ${state.elapsedMin.toFixed(1)} min`,
    `- Silence: ${state.silenceMin.toFixed(1)} min`,
    `- Last transition: ${lastTransitionAgo.toFixed(1)} min ago (entered ${state.phase})`,
  ]
  if (lastReview) {
    const dayWord = lastReview.daysAgo === 1 ? 'day' : 'days'
    const durStr = lastReview.durationMin != null ? `${lastReview.durationMin} min` : 'unknown'
    lines.push(
      `- Last session (${lastReview.daysAgo} ${dayWord} ago, ${durStr}): ${lastReview.summary}`,
    )
    lines.push(`- Last session keywords: ${lastReview.keywords.join(', ')}`)
  }
  return lines.join('\n')
}
