/**
 * LLM retry wrapper. v0.7.6.
 *
 * `client.chatStream()` has no built-in retry. A transient 5xx, rate-limit
 * (429), or network hiccup would otherwise bubble up to the CLI main loop
 * and kill the whole session. V751-002 captured this as a filed issue.
 *
 * `chatStreamWithRetry` adds a thin classified-retry layer:
 *   - On a retryable error (rate_limit / 5xx / network), wait 1s and try
 *     again, up to `maxAttempts` (default: 2 — i.e. 1 initial + 1 retry).
 *   - On a non-retryable error (4xx, unknown), fail fast and throw.
 *   - Each error is logged to stderr with the classification so the
 *     operator can see what happened in the live demo.
 *
 * The CLI main loop catches the final throw and degrades gracefully
 * (writes a friendly fallback message + auto-saves the session with a
 * placeholder summary + exits 1). See v0.7.6-design.md §3.1.
 */

import { classifyLLMError } from './errors.js'
import type { ChatChunk, ChatOpts, LLMClient, UsageChunk } from './types.js'

export interface StreamResult {
  response: string
  usage: UsageChunk | null
}

const DEFAULT_MAX_ATTEMPTS = 2
const RETRY_DELAY_MS = 1000

// v0.8.5 — streaming variant that yields ChatChunks as they arrive.
// runTurn() uses this for true text-chunk streaming to the browser.
export async function* chatStreamWithRetryGen(
  client: LLMClient,
  opts: ChatOpts,
  maxAttempts: number = DEFAULT_MAX_ATTEMPTS,
): AsyncGenerator<ChatChunk, void, void> {
  if (maxAttempts < 1) {
    throw new Error(`chatStreamWithRetry: maxAttempts must be >= 1, got ${maxAttempts}`)
  }

  let lastErr: unknown = null
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      for await (const chunk of client.chatStream(opts)) {
        yield chunk
      }
      return
    } catch (err) {
      lastErr = err
      const classified = classifyLLMError(err)
      process.stderr.write(
        `[cli] llm error: ${classified.classification} (${(err as Error).message})\n`,
      )
      if (!classified.retryable) break
      if (attempt < maxAttempts) {
        process.stderr.write(
          `[cli] retrying in ${RETRY_DELAY_MS / 1000}s... (attempt ${attempt + 1}/${maxAttempts})\n`,
        )
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS))
      }
    }
  }
  throw lastErr
}

// v0.7.6 — buffered variant kept for backward compatibility (used by summarize
// and other non-streaming callers). Internally wraps chatStreamWithRetryGen.
export async function chatStreamWithRetry(
  client: LLMClient,
  opts: ChatOpts,
  maxAttempts: number = DEFAULT_MAX_ATTEMPTS,
  onAttempt?: (attempt: number, err: unknown) => void,
): Promise<StreamResult> {
  let response = ''
  let usage: UsageChunk | null = null
  try {
    for await (const chunk of chatStreamWithRetryGen(client, opts, maxAttempts)) {
      if (chunk.type === 'text') {
        response += chunk.delta
      } else if (chunk.type === 'usage') {
        usage = chunk
      }
    }
  } catch (err) {
    if (onAttempt) onAttempt(maxAttempts, err)
    throw err
  }
  return { response, usage }
}
