import Anthropic from '@anthropic-ai/sdk'
import type { Env } from '../config/env.js'
import type { ChatChunk, ChatOpts, ChatResult, LLMClient, UsageChunk } from './types.js'

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

export function createAnthropicProvider(env: Env): LLMClient {
  const client = new Anthropic({
    apiKey: env.MINIMAX_API_KEY,
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
      messages: opts.messages.map((m) => ({
        role: m.role === 'system' ? 'user' : m.role,
        content: m.content,
      })),
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
