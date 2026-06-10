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
  /** Number of (user, assistant) pairs dropped from the start. */
  dropped: number
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
 * Pure function — no IO, no Date.now, no side effects. Safe to call in
 * tight loops. O(n) in `messages.length`.
 *
 * v0.7.5.
 */
export function truncateHistory(
  messages: Message[],
  budget: number,
  systemSize = 0,
): TruncateResult {
  let current = messages
  let dropped = 0
  while (current.length > 2) {
    const total = estimateMessagesTokens(current) + systemSize
    if (total <= budget) break
    current = current.slice(2)
    dropped += 1
  }
  return { messages: current, dropped }
}
