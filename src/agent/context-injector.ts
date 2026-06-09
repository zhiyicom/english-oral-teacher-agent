import type { RelevantSession } from '../memory/retrieve-relevant.js'
import type { Mistake } from '../storage/mistakes.js'
import type { TopicStat } from '../storage/topics.js'
import type { LastReview } from './retrieval.js'
import type { SessionState } from './state-machine.js'

/**
 * Build the `[System Context]` block that gets appended to the LLM system prompt.
 *
 * v0.5 — adds an optional "Last session" segment when a `lastReview` is provided.
 * The segment is only added when `lastReview` is non-null; the caller (CLI) is
 * responsible for passing it ONLY on the first turn of the session (first-turn-only
 * injection per v0.5 design §2.5).
 *
 * v0.6 — adds an optional "Active topics" segment. Unlike `lastReview` (which
 * is per-session retrospective and goes stale), `activeTopics` is a cross-session
 * aggregate that stays useful for every turn, so the caller passes it for the
 * entire session. Top 5 by recency (DAO already sorts DESC by last_discussed_at).
 *
 * v0.7.1 — adds an optional "Recent mistakes" segment. Cross-session mistake
 * history loaded once at startup (`mistakes.getRecent(5)`) and passed in
 * unchanged for the whole session. Same load-once strategy as `activeTopics`;
 * see v0.7.1 design §3.2.
 *
 * v0.7.2 — adds an optional "Relevant past sessions" segment for semantic
 * cross-session recall (top-K cosine on summary embeddings). Rendered between
 * "Last session" and "Active topics" so the two historical segments are
 * physically adjacent. Parameter is appended at the end of the signature to
 * keep older callers compiling; the render order is intentional, see §6.3 of
 * v0.7.2 design.
 *
 * `now` defaults to `Date.now()`; pass an explicit Date for deterministic tests.
 */
export function buildSystemContext(
  state: SessionState,
  lastReview: LastReview | null = null,
  activeTopics: TopicStat[] = [],
  recentMistakes: Mistake[] = [],
  relevantPast: RelevantSession[] = [],
  now: Date = new Date(),
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
  if (relevantPast.length > 0) {
    const top = relevantPast.slice(0, 2)
    lines.push(`- Relevant past sessions (N=${top.length}):`)
    for (const r of top) {
      const truncated = r.summary.length > 80 ? `${r.summary.slice(0, 80)}...` : r.summary
      const kwStr = r.keywords.join(', ')
      const dayWord = r.daysAgo === 1 ? 'day' : 'days'
      lines.push(`  - ${r.daysAgo} ${dayWord} ago: "${truncated}" (keywords: ${kwStr})`)
    }
  }
  if (activeTopics.length > 0) {
    const top = activeTopics.slice(0, 5)
    const parts = top.map((t) => {
      const daysAgo = computeDaysAgo(t.lastDiscussedAt, now)
      const timeWord = t.discussionCount === 1 ? 'time' : 'times'
      return `${t.topic} (${t.discussionCount} ${timeWord}, ${formatDaysAgo(daysAgo)})`
    })
    lines.push(`- Active topics: ${parts.join(', ')}`)
  }
  if (recentMistakes.length > 0) {
    const top = recentMistakes.slice(0, 5)
    lines.push(`- Recent mistakes (N=${top.length}):`)
    for (const m of top) {
      lines.push(`  - "${m.original}" → "${m.corrected}" (${m.category})`)
    }
  }
  return lines.join('\n')
}

function computeDaysAgo(isoTs: string | null, now: Date): number {
  if (!isoTs) return Number.MAX_SAFE_INTEGER // never discussed → huge daysAgo
  const tsMs = Date.parse(isoTs)
  return Math.max(0, Math.floor((now.getTime() - tsMs) / 86_400_000))
}

function formatDaysAgo(n: number): string {
  if (n === 0) return 'today'
  if (n === 1) return 'yesterday'
  if (n >= 2) return `${n} days ago`
  return 'unknown'
}
