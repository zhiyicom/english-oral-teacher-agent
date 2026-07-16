/**
 * v1.1.2 §1.2 — three-tier fallback text for the `topic_select` blocked
 * branch (MIN_TOPIC_AGE gate rejects an LLM's call to switch topics).
 *
 * `blockedCount` is a session-level counter (incremented once per blocked
 * turn) carried in `TurnDeps.blockedCount`. v1.1.1 used a single
 * deterministic sentence; that caused 4-5 consecutive "复读机" replies
 * because the LLM tended to repeat the previous turn's wording. The
 * three-tier ladder lets the assistant escalate from neutral
 * (tier 1) to "we're circling" (tier 3) so the student sees a fresh
 * message each time, and so tier ≥ 2 can attach the fresh hints
 * (topic + keyword) computed by `pickFreshHints`.
 *
 * - tier 1 (blockedCount === 0): identical to v1.1.1 — pure continuation
 *   prompt, no system-y phrasing, no hint injection.
 * - tier 2 (blockedCount === 1): acknowledges the previous attempt
 *   didn't take; hints at "try something different". Keyword hint only.
 * - tier 3 (blockedCount >= 2): explicitly invites the student to bring
 *   the topic; double-layered (keyword + topic) hint attached.
 *
 * All three tiers speak English only — SOUL.md:16 keeps the whole session
 * in English regardless of student native language.
 */
export function pickBlockedFallback(blockedCount: number): string {
  if (blockedCount <= 0) return "Let's keep going with this — tell me more."
  if (blockedCount === 1) {
    return "Hmm, that one didn't take. Let's try something different — what haven't we talked about recently?"
  }
  // blockedCount >= 2
  return "We seem to keep circling. Let's pick something completely fresh — what catches your eye right now?"
}
