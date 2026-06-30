import Anthropic from '@anthropic-ai/sdk'
import type { Env } from '../config/env.js'
import { getApiKey } from '../config/secrets.js'
import type { ChatChunk, ChatOpts, ChatResult, LLMClient, Message, UsageChunk } from './types.js'

/**
 * Subset of Anthropic streaming events we care about. The SDK emits many
 * more (content_block_start, content_block_stop, message_delta, ping,
 * error, etc.) but we only need delta content + the message_start usage.
 * The trailing union member is a tag-only type so the discriminated
 * narrowing in the `for await` loop works (it matches anything we don't
 * care about and we ignore it at runtime).
 */
type AnthropicEvent =
  | {
      type: 'message_start'
      message: {
        usage: {
          input_tokens: number
          output_tokens: number
          cache_creation_input_tokens?: number | null
          cache_read_input_tokens?: number | null
        }
      }
    }
  | {
      type: 'content_block_delta'
      index?: number
      delta?: {
        type?: string
        text?: string
        thinking?: string
      }
    }
  | {
      type:
        | 'content_block_start'
        | 'content_block_stop'
        | 'message_delta'
        | 'message_stop'
        | 'ping'
        | 'error'
    }

/**
 * v0.7.6 B4 — convert Message[] to Anthropic message params, applying
 * `cache_control: ephemeral` to the last `CACHE_LAST_N` messages.
 *
 * Why mark the END of messages[]:
 *   - Anthropic caches the prefix UP TO AND INCLUDING the breakpoint.
 *   - The latest user message is the only new content this turn; everything
 *     before it is unchanged from the previous turn's request (modulo the
 *     dynamic system block, which we deliberately keep small so the rest
 *     of the prefix remains cacheable).
 *   - On the NEXT turn, the message that was "latest" this turn becomes
 *     second-to-latest. If we marked the last TWO messages, that "old
 *     latest" still has its breakpoint, and the next turn can hit the
 *     cache for the prefix up through it.
 *
 * Breakpoint budget: Anthropic allows up to 4 cache breakpoints per
 * request. We already use 1 for the static system block (v0.7.5), so 3
 * remain. We use 2 here, leaving 1 of headroom.
 *
 * v0.7.5 confirmed the SDK accepts cache_control on system blocks. If the
 * SDK or upstream rejects cache_control on message content blocks, the
 * existing chatStreamWithRetry classifies the resulting error as 4xx
 * (non-retryable) and the CLI's fallback path kicks in — the operator
 * will then see the failure and can disable B4 (revert this file) without
 * data loss. The marking is intentionally minimal so a revert is cheap.
 */
const CACHE_LAST_N = 2

function toAnthropicMessages(messages: Message[]): Anthropic.Messages.MessageParam[] {
  const cacheStartIdx = Math.max(0, messages.length - CACHE_LAST_N)
  return messages.map((m, i) => {
    const role = m.role === 'system' ? ('user' as const) : m.role
    if (i >= cacheStartIdx) {
      return {
        role,
        content: [
          {
            type: 'text' as const,
            text: m.content,
            cache_control: { type: 'ephemeral' as const },
          },
        ],
      }
    }
    return { role, content: m.content }
  })
}
export function createAnthropicProvider(env: Env): LLMClient {
  const apiKey = getApiKey()
  if (!apiKey) {
    throw new Error(
      'API_KEY not configured. Open http://localhost:<port>/setup to configure, ' +
      'or set API_KEY in .env / process.env.',
    )
  }
  const client = new Anthropic({
    apiKey,
    baseURL: env.ANTHROPIC_BASE_URL,
  })

  async function* chatStream(opts: ChatOpts): AsyncIterable<ChatChunk> {
    // v0.7.5 — prefer `systemBlocks` (carries cache_control); fall back to
    // legacy `system: string` for any caller that hasn't been updated.
    const systemParam = opts.systemBlocks ?? opts.system

    const stream = await client.messages.create({
      model: env.LLM_MODEL_MAIN,
      max_tokens: opts.maxTokens ?? env.LLM_MAX_TOKENS,
      temperature: opts.temperature ?? env.LLM_TEMPERATURE,
      system: systemParam,
      messages: toAnthropicMessages(opts.messages),
      stream: true,
    })

    for await (const event of stream as unknown as AsyncIterable<AnthropicEvent>) {
      if (event.type === 'message_start') {
        const u = event.message.usage
        const usage: UsageChunk = {
          type: 'usage',
          inputTokens: u.input_tokens,
          outputTokens: u.output_tokens,
          cacheReadTokens: u.cache_read_input_tokens ?? 0,
          cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
        }
        yield usage
      } else if (event.type === 'content_block_delta') {
        const delta = event.delta
        if (!delta) continue
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          yield { type: 'text', delta: delta.text }
        } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          yield { type: 'thinking', delta: delta.thinking }
        }
      }
      // All other event types are ignored (content_block_start/stop,
      // message_delta, message_stop, ping, error). v0.7.5 only needs
      // the message_start usage + the text/thinking deltas.
    }
  }

  async function chat(opts: ChatOpts): Promise<ChatResult> {
    let text = ''
    let thinking = ''
    let usage: UsageChunk | null = null
    for await (const chunk of chatStream(opts)) {
      if (chunk.type === 'text') text += chunk.delta
      else if (chunk.type === 'thinking') thinking += chunk.delta
      else if (chunk.type === 'usage') usage = chunk
    }
    return {
      content: text,
      thinking: thinking.length > 0 ? thinking : undefined,
      usage: usage ?? undefined,
    }
  }

  return { chatStream, chat }
}
