import { z } from 'zod'
import type { Tool } from '../tool-registry.js'

/**
 * `summarize_history` tool. v0.7.6 B2.
 *
 * Marker tool. The tool itself does NOT touch history — the conversation
 * history lives in the CLI's main loop scope, not in the tool. `execute`
 * just parses + validates the args and returns a typed signal so the CLI
 * knows it should:
 *   1. Compress everything older than the last `KEEP_RECENT` messages
 *      using the existing `summarize()` function.
 *   2. Rebuild `history` as `[...anchorPair, summaryMessage, ...recent]`.
 *   3. Run one more LLM call (A+B hybrid, same as `memory_search`) so the
 *      LLM can respond to the student with the now-compressed context.
 *
 * Protocol: A+B hybrid (see v0.7.3-design.md §2). The CLI feeds a synthetic
 * user message `[v076_history_summary]\n…` back to the LLM as a 2nd call,
 * matching the `memory_search` pattern. The marker `[v076_history_summary]`
 * is unique so Replay fixtures can disambiguate the 2nd call.
 */

export const SummarizeHistoryArgsSchema = z.object({
  target_tokens: z.number().int().min(100).max(3000).default(500),
})

export type SummarizeHistoryArgs = z.infer<typeof SummarizeHistoryArgsSchema>

export interface SummarizeHistoryResult {
  kind: 'summarize_history'
  targetTokens: number
}

const DESCRIPTION =
  'Compress the older part of the current conversation history to fit within ' +
  'target_tokens. Use when the conversation is getting long. The system will ' +
  'replace older messages with a summary and make a 2nd LLM call so you can ' +
  'respond. Do NOT call any tool in your 2nd response.'

export function createSummarizeHistoryTool(): Tool {
  return {
    name: 'summarize_history',
    description: DESCRIPTION,
    schema: SummarizeHistoryArgsSchema,
    async execute(args: unknown): Promise<SummarizeHistoryResult> {
      const parsed = SummarizeHistoryArgsSchema.parse(args)
      return { kind: 'summarize_history', targetTokens: parsed.target_tokens }
    },
  }
}
