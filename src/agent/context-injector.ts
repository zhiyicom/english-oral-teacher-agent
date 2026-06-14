import type { RelevantSession } from '../memory/retrieve-relevant.js'
import type { Mistake } from '../storage/mistakes.js'
import type { TopicStat } from '../storage/topics.js'
import type { LastReview } from './retrieval.js'
import type { SessionState } from './state-machine.js'
import { estimateTokens } from './truncate-history.js'

/**
 * Result of building the [System Context] block. v0.7.6 B3 splits the
 * result into:
 *   - `text`  — the rendered multi-line block (same content as v0.7.5 returned)
 *   - `segments` — per-segment estimated token counts (each field = the
 *     chars/4 estimate of that segment's text, 0 if the segment was absent).
 *
 * The CLI logs `segments` to stderr so the operator can see which segment
 * is the biggest contributor to context cost. v0.7.5 had no per-segment
 * view — the whole [System Context] block was opaque. See v0.7.6-design.md
 * §3.4.
 */
export interface SystemContextResult {
  text: string
  segments: {
    phase: number
    last: number
    relevant: number
    active: number
    mistakes: number
  }
}

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
 * v0.7.6 B3 — returns `SystemContextResult` (text + per-segment token counts)
 * instead of just a string. Existing callers that did `.text` keep working
 * after the v0.7.5 callers are updated to use `buildFinalSystemSplit`/
 * `buildFinalSystemSegments`. Old call sites that need the plain string
 * can read `result.text`.
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
): SystemContextResult {
  const lastTransitionAgo = Math.max(0, state.elapsedMin - state.lastTransitionAt)

  // v0.8.5 — inject phase-specific behavior instructions directly into the
  // system context so the LLM doesn't need to remember SOUL.md from 4000+
  // tokens earlier. Each phase gets a clear, actionable directive.
  const PHASE_INSTRUCTIONS: Record<string, string> = {
    WARM_UP: [
      '## You are in WARM_UP phase (0-5 min). Your task:',
      '- Greet warmly, ask 1-2 simple open-ended questions (day, week, interests)',
      '- Keep it light — NO heavy topics, NO grammar corrections',
      '- Goal: make the student comfortable speaking English',
    ].join('\n'),
    MAIN_ACTIVITY: [
      '## You are in MAIN_ACTIVITY phase (5-25 min). Your task:',
      '- Pick a topic from # TOPIC_LIBRARY (match the student\'s level in # STUDENT)',
      '- Student does ~70% of the talking — use open-ended follow-ups',
      '- Teach 2-3 new words/expressions naturally within the conversation',
      '- Gently correct errors by rephrasing correctly',
      '- If topic runs dry or 3+ short answers → switch topic from library',
      '- Under 25 min: NEVER end the session; at ~23 min: signal wrap-up coming',
    ].join('\n'),
    WRAP_UP: [
      '## You are in WRAP_UP phase (25-30 min). CRITICAL — follow these steps NOW:',
      '- DO NOT introduce new topics or ask open-ended questions',
      '- Summarize 1-2 things practiced or improved today',
      '- Point out 1 thing the student did well',
      '- Mention 1 thing to work on next time',
      '- Suggest a mini practice task',
      '- Move the conversation toward a natural close',
    ].join('\n'),
    END: [
      '## You are in END phase. This is your FINAL message:',
      '- Say goodbye warmly in 1-2 sentences',
      '- Thank the student',
      '- DO NOT ask any questions or introduce anything new',
    ].join('\n'),
  }

  const instruction = PHASE_INSTRUCTIONS[state.phase] ?? ''
  const phaseSeg = [
    instruction,
    '',
    `[System Context] Phase: ${state.phase} | Elapsed: ${state.elapsedMin.toFixed(1)} min | Silence: ${state.silenceMin.toFixed(1)} min | Entered ${state.phase} ${lastTransitionAgo.toFixed(1)} min ago`,
  ].join('\n')
  const lines: string[] = [phaseSeg]

  let lastSeg = ''
  if (lastReview) {
    const dayWord = lastReview.daysAgo === 1 ? 'day' : 'days'
    const durStr = lastReview.durationMin != null ? `${lastReview.durationMin} min` : 'unknown'
    lastSeg = [
      `- Last session (${lastReview.daysAgo} ${dayWord} ago, ${durStr}): ${lastReview.summary}`,
      `- Last session keywords: ${lastReview.keywords.join(', ')}`,
    ].join('\n')
    lines.push(lastSeg)
  }

  let relevantSeg = ''
  if (relevantPast.length > 0) {
    const top = relevantPast.slice(0, 2)
    const segLines: string[] = [`- Relevant past sessions (N=${top.length}):`]
    for (const r of top) {
      const truncated = r.summary.length > 80 ? `${r.summary.slice(0, 80)}...` : r.summary
      const kwStr = r.keywords.join(', ')
      const dayWord = r.daysAgo === 1 ? 'day' : 'days'
      segLines.push(`  - ${r.daysAgo} ${dayWord} ago: "${truncated}" (keywords: ${kwStr})`)
    }
    relevantSeg = segLines.join('\n')
    lines.push(relevantSeg)
  }

  let activeSeg = ''
  if (activeTopics.length > 0) {
    const top = activeTopics.slice(0, 5)
    const parts = top.map((t) => {
      const daysAgo = computeDaysAgo(t.lastDiscussedAt, now)
      const timeWord = t.discussionCount === 1 ? 'time' : 'times'
      return `${t.topic} (${t.discussionCount} ${timeWord}, ${formatDaysAgo(daysAgo)})`
    })
    activeSeg = `- Active topics: ${parts.join(', ')}`
    lines.push(activeSeg)
  }

  let mistakesSeg = ''
  if (recentMistakes.length > 0) {
    const top = recentMistakes.slice(0, 5)
    const segLines: string[] = [`- Recent mistakes (N=${top.length}):`]
    for (const m of top) {
      segLines.push(`  - "${m.original}" → "${m.corrected}" (${m.category})`)
    }
    mistakesSeg = segLines.join('\n')
    lines.push(mistakesSeg)
  }

  return {
    text: lines.join('\n'),
    segments: {
      phase: estimateTokens(phaseSeg),
      last: lastSeg ? estimateTokens(lastSeg) : 0,
      relevant: relevantSeg ? estimateTokens(relevantSeg) : 0,
      active: activeSeg ? estimateTokens(activeSeg) : 0,
      mistakes: mistakesSeg ? estimateTokens(mistakesSeg) : 0,
    },
  }
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
