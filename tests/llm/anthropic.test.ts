import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../../src/config/env.js'
import { createAnthropicProvider } from '../../src/llm/anthropic.js'

function makeEnv(): Env {
  return {
    LLM_PROVIDER: 'minimax',
    MINIMAX_API_KEY: 'sk-test',
    ANTHROPIC_BASE_URL: 'http://test.local',
    LLM_MODEL_MAIN: 'MiniMax-M3',
    LLM_MODEL_SUMMARIZER: 'MiniMax-M3',
    LLM_TEMPERATURE: 0.7,
    LLM_MAX_TOKENS: 100,
    APP_DATA_DIR: './data',
    APP_LOG_LEVEL: 'info',
  }
}

async function* fakeStream(events: Array<Record<string, unknown>>) {
  for (const e of events) yield e
}

// Mock the @anthropic-ai/sdk so that new Anthropic(...) returns a fake client.
vi.mock('@anthropic-ai/sdk', () => {
  const Anthropic = vi.fn().mockImplementation(() => {
    return { __fakeClient: true }
  })
  return { default: Anthropic }
})

import Anthropic from '@anthropic-ai/sdk'

describe('AnthropicProvider', () => {
  let createSpy: ReturnType<typeof vi.fn>
  let originalImpl: unknown

  beforeEach(() => {
    createSpy = vi.fn()
    // Patch the fake instance returned by `new Anthropic(...)` with a messages.create mock
    ;(Anthropic as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      messages: { create: createSpy },
    }))
    originalImpl = (Anthropic as unknown as ReturnType<typeof vi.fn>).getMockImplementation()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('converts user/assistant/system messages to Anthropic format', async () => {
    createSpy.mockResolvedValue(
      fakeStream([
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi!' } },
        { type: 'message_stop' },
      ]),
    )

    const client = createAnthropicProvider(makeEnv())
    const result = await client.chat({
      system: 'sys-prompt',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi back' },
        { role: 'user', content: 'how are you' },
      ],
    })

    expect(result.content).toBe('Hi!')
    expect(createSpy).toHaveBeenCalledTimes(1)
    const call = createSpy.mock.calls[0]?.[0] as Record<string, unknown>
    expect(call.model).toBe('MiniMax-M3')
    expect(call.system).toBe('sys-prompt')
    expect(call.stream).toBe(true)
    const messages = call.messages as Array<{ role: string; content: string }>
    expect(messages).toHaveLength(3)
    expect(messages[0]).toEqual({ role: 'user', content: 'hello' })
    expect(messages[1]).toEqual({ role: 'assistant', content: 'hi back' })
  })

  it('separates thinking deltas from text deltas', async () => {
    createSpy.mockResolvedValue(
      fakeStream([
        { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm ' } },
        {
          type: 'content_block_delta',
          delta: { type: 'thinking_delta', thinking: 'let me think' },
        },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'answer' } },
      ]),
    )

    const client = createAnthropicProvider(makeEnv())
    const result = await client.chat({
      system: 's',
      messages: [{ role: 'user', content: 'q' }],
    })

    expect(result.content).toBe('answer')
    expect(result.thinking).toBe('hmm let me think')
  })
})
