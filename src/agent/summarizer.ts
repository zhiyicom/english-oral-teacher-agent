import { z } from 'zod'
import type { LLMClient, Message } from '../llm/types.js'
import { getSummarizerSystemPrompt } from '../prompts/loader.js'

export const SummarySchema = z.object({
  summary: z.string().min(20, 'summary 太短 (< 20 chars)').max(800, 'summary 太长 (> 800 chars)'),
  keywords: z
    .array(z.string().min(1).max(40))
    .min(3, 'keywords 至少 3 个')
    .max(8, 'keywords 最多 8 个'),
})

export type Summary = z.infer<typeof SummarySchema>

/**
 * Truncation policy: if there are more than 25 messages, keep the first 20
 * and the last 5. This protects against LLM token blow-up on long sessions
 * while preserving both the opening (topic intro) and the closing (wrap-up).
 */
export function truncateMessages(messages: Message[]): Message[] {
  if (messages.length <= 25) return messages
  return [...messages.slice(0, 20), ...messages.slice(-5)]
}

/**
 * Build the final user message that requests a summary. This is the message
 * the Replay provider's `pickFixture` looks at.
 *
 * The `[SUMMARIZER_INSTRUCTION]` marker is load-bearing: it's the unique
 * substring that the `summarize.json` fixture's `match.userSaysContains` looks
 * for. We use a unique marker (not just "summarize") because the LAST user
 * message must NOT contain words like "castle" / "creeper" / "played" that
 * would match OTHER fixtures first (the Replay provider iterates fixtures in
 * filesystem order, first match wins). The transcript itself is sent as a
 * series of preceding user/assistant messages, NOT embedded in this final
 * instruction.
 */
export function buildSummaryInstruction(): Message {
  return {
    role: 'user',
    content:
      '[SUMMARIZER_INSTRUCTION]\n' +
      'Please summarize the English conversation session above (between a ' +
      'teacher named Alex and a student). Return a JSON object with two fields:\n' +
      `- "summary": 1-3 sentences (50-150 tokens) describing what the student ` +
      'practiced and what the teacher focused on.\n' +
      `- "keywords": 3-8 lowercase English words or short phrases capturing ` +
      'the key topics, vocabulary, and themes.\n\n' +
      'Output ONLY the JSON, no other text or markdown.',
  }
}

function formatTranscript(messages: Message[]): string {
  return messages.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join('\n')
}

/**
 * Call the LLM to summarize a session's messages. Returns a validated Summary.
 *
 * The transcript is sent as a sequence of user/assistant messages, with a
 * final user message that contains the [SUMMARIZER_INSTRUCTION] marker.
 * This way the Replay provider's pickFixture (which looks at the last user
 * message) only sees the marker, not transcript content that could match
 * other fixtures (e.g. "castle" / "creeper" / "played").
 *
 * Throws if:
 * - The LLM response is not valid JSON
 * - The JSON does not match SummarySchema (e.g. wrong field count, length out of range)
 *
 * The CLI wraps this in a try/catch and falls back to a placeholder summary
 * on failure so the session can still END gracefully.
 */
export async function summarize(messages: Message[], client: LLMClient): Promise<Summary> {
  const truncated = truncateMessages(messages)
  const system = getSummarizerSystemPrompt()
  const summaryRequest: Message[] = [...truncated, buildSummaryInstruction()]

  const response = await client.chat({ system, messages: summaryRequest })

  let parsed: unknown
  try {
    parsed = JSON.parse(response.content)
  } catch (err) {
    throw new Error(
      `summarizer LLM response is not valid JSON: ${(err as Error).message}\n` +
        `Response was: ${response.content.slice(0, 200)}`,
    )
  }

  return SummarySchema.parse(parsed)
}
