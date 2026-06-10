import type { Message } from '../llm/types.js'

/**
 * Cheap token estimator: 1 token ≈ 4 characters. Conservative for English
 * (over-counts by ~50%) and reasonable for Chinese mixed text (over-counts
 * by ~25%). Used for PRE-truncate decisions because the SDK only reports
 * actual usage AFTER the call. The SDK's input_tokens (via message_start
 * .usage) is the ground truth, used for post-call logging and 80% warn.
 *
 * v0.7.5.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export function estimateMessagesTokens(messages: Message[]): number {
  let total = 0
  for (const m of messages) total += estimateTokens(m.content)
  return total
}

export interface TruncateResult {
  messages: Message[]
  /** Number of (user, assistant) pairs dropped from the droppable portion. */
  dropped: number
}

export interface TruncateOptions {
  /**
   * Tokens consumed by the system prompt (static + dynamic). Added to the
   * estimated total so the budget check uses the full pre-call input size,
   * not just the messages portion. Defaults to 0.
   */
  systemSize?: number
  /**
   * First user/assistant pair; protected from being dropped. If `messages`
   * starts with this exact pair (by role + content), the pair is preserved
   * and the truncate loop only operates on the remaining "droppable"
   * portion. If absent or doesn't match the head, behaves as v0.7.5
   * (drop from the very front).
   *
   * v0.7.6 B1 — anchor pair. Anchors the conversation context (WARM_UP
   * phase's first exchange) so the LLM doesn't lose the persona/topic
   * framing as the session grows long. See v0.7.6-design.md §3.2.
   */
  anchorPair?: readonly Message[]
}

/**
 * Drop oldest user/assistant pairs from `messages` until estimated total
 * (messages + systemSize) ≤ `budget`. Always keeps at least 2 messages
 * (the most recent pair) even if they exceed budget — stripping to empty
 * would break the chat loop. Truncation is in pairs of 2 (1 turn);
 * pairs are never split. Synthetic user messages (e.g. v0.7.3
 * `[tool_result_v073]` markers) are treated the same as natural user
 * messages and may be dropped as part of a pair.
 *
 * v0.7.5 — base behavior.
 * v0.7.6 — added `anchorPair` option. The first N messages (where N =
 * anchorPair.length) are stripped from the front of `messages` and
 * re-attached at the end, so the truncate loop only drops from the
 * "droppable" middle/older portion. The anchor pair is never dropped.
 *
 * Pure function — no IO, no Date.now, no side effects. Safe to call in
 * tight loops. O(n) in `messages.length`.
 */
export function truncateHistory(
  messages: Message[],
  budget: number,
  options: TruncateOptions = {},
): TruncateResult {
  const { systemSize = 0, anchorPair = [] } = options

  // v0.7.6 B1 — separate the anchor (protected prefix) from the droppable
  // portion. The anchor is preserved verbatim and never dropped. The
  // droppable portion is what the truncate loop operates on.
  let protectedHead: Message[] = []
  let droppable = messages
  if (anchorPair.length > 0 && messages.length >= anchorPair.length) {
    const head = messages.slice(0, anchorPair.length)
    const headMatches = head.every(
      (m, i) => m.role === anchorPair[i]?.role && m.content === anchorPair[i]?.content,
    )
    if (headMatches) {
      protectedHead = [...head]
      droppable = messages.slice(anchorPair.length)
    }
    // If head doesn't match (e.g. anchorPair is from a different session
    // or messages was already truncated), fall back to v0.7.5 behavior:
    // the entire `messages` is droppable. This is intentionally silent —
    // mismatched anchor is a benign state, not an error.
  }

  let current = droppable
  let dropped = 0
  while (current.length > 2) {
    const total = estimateMessagesTokens([...protectedHead, ...current]) + systemSize
    if (total <= budget) break
    current = current.slice(2)
    dropped += 1
  }
  return { messages: [...protectedHead, ...current], dropped }
}
