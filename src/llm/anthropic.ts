import Anthropic from '@anthropic-ai/sdk'
import type { Env } from '../config/env.js'
import type { ChatChunk, ChatOpts, ChatResult, LLMClient } from './types.js'

type AnthropicEvent = {
  type: string
  index?: number
  delta?: {
    type?: string
    text?: string
    thinking?: string
  }
}

export function createAnthropicProvider(env: Env): LLMClient {
  const client = new Anthropic({
    apiKey: env.MINIMAX_API_KEY,
    baseURL: env.ANTHROPIC_BASE_URL,
  })

  async function* chatStream(opts: ChatOpts): AsyncIterable<ChatChunk> {
    const stream = await client.messages.create({
      model: env.LLM_MODEL_MAIN,
      max_tokens: opts.maxTokens ?? env.LLM_MAX_TOKENS,
      temperature: opts.temperature ?? env.LLM_TEMPERATURE,
      system: opts.system,
      messages: opts.messages.map((m) => ({
        role: m.role === 'system' ? 'user' : m.role,
        content: m.content,
      })),
      stream: true,
    })

    for await (const event of stream as unknown as AsyncIterable<AnthropicEvent>) {
      if (event.type !== 'content_block_delta') continue
      const delta = event.delta
      if (!delta) continue

      if (delta.type === 'text_delta' && typeof delta.text === 'string') {
        yield { type: 'text', delta: delta.text }
      } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
        yield { type: 'thinking', delta: delta.thinking }
      }
    }
  }

  async function chat(opts: ChatOpts): Promise<ChatResult> {
    let text = ''
    let thinking = ''
    for await (const chunk of chatStream(opts)) {
      if (chunk.type === 'text') text += chunk.delta
      else thinking += chunk.delta
    }
    return {
      content: text,
      thinking: thinking.length > 0 ? thinking : undefined,
    }
  }

  return { chatStream, chat }
}
