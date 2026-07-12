import { afterEach, describe, expect, it, vi } from 'vitest'
import { getApiKey } from '../../src/config/secrets.js'
import { createOpenAIProvider } from '../../src/llm/openai.js'

vi.mock('../../src/config/secrets.js', () => ({
  getApiKey: vi.fn(() => 'sk-test'),
}))

const getApiKeyMock = vi.mocked(getApiKey)

type AppLogLevel = 'debug' | 'info' | 'warn' | 'error'

function makeEnv(overrides: Partial<{ API_KEY: string | undefined; ANTHROPIC_BASE_URL: string }> = {}) {
  return {
    API_STYLE: 'openai' as const,
    API_KEY: 'sk-test',
    ANTHROPIC_BASE_URL: 'https://api.deepseek.com/v1',
    LLM_MODEL: 'deepseek-chat',
    LLM_TEMPERATURE: 0.7,
    LLM_MAX_TOKENS: 100,
    APP_DATA_DIR: './data',
    APP_LOG_LEVEL: 'info' as AppLogLevel,
    LLM_CONTEXT_BUDGET_TOKENS: 6000,
    PORT: 3000,
    ...overrides,
  }
}

describe('createOpenAIProvider (v1.0.8 §1.7)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    getApiKeyMock.mockReturnValue('sk-test')
  })

  it('throws with a clear message when no API key is configured', () => {
    getApiKeyMock.mockReturnValueOnce(null)
    expect(() => createOpenAIProvider(makeEnv({ API_KEY: undefined }))).toThrow(/API_KEY not configured/)
  })

  it('POSTs to <baseURL>/chat/completions with Authorization: Bearer header', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response('data: [DONE]\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    )
    vi.stubGlobal('fetch', fetchSpy)

    const provider = createOpenAIProvider(makeEnv())
    await provider.chat({
      system: 'be helpful',
      messages: [{ role: 'user', content: 'hi' }],
    })

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.deepseek.com/v1/chat/completions')
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer sk-test')
    expect(headers['Content-Type']).toBe('application/json')
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body.model).toBe('deepseek-chat')
    expect(body.stream).toBe(true)
    expect(body.messages).toEqual([
      { role: 'system', content: 'be helpful' },
      { role: 'user', content: 'hi' },
    ])
  })

  it('strips trailing slash from baseURL before appending path', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response('data: [DONE]\n\n', { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchSpy)
    const provider = createOpenAIProvider(makeEnv({ ANTHROPIC_BASE_URL: 'https://api.openai.com/v1/' }))
    await provider.chat({ messages: [{ role: 'user', content: 'q' }] })
    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.openai.com/v1/chat/completions')
  })

  it('uses DeepSeek documented base URL https://api.deepseek.com (no /v1) without double-prefixing', async () => {
    // DeepSeek's official OpenAI-compatible base URL is just the apex
    // (https://api.deepseek.com), NOT https://api.deepseek.com/v1. Verify
    // we don't accidentally insert a /v1/ between the host and the path.
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response('data: [DONE]\n\n', { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchSpy)
    const provider = createOpenAIProvider(makeEnv({ ANTHROPIC_BASE_URL: 'https://api.deepseek.com' }))
    await provider.chat({ messages: [{ role: 'user', content: 'q' }] })
    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.deepseek.com/chat/completions')
  })

  it('attaches .status to thrown errors so classifyLLMError sees the bucket', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: 'Invalid API key', type: 'auth' } }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )
    const provider = createOpenAIProvider(makeEnv())
    await expect(
      provider.chat({ messages: [{ role: 'user', content: 'q' }] }),
    ).rejects.toMatchObject({ status: 401, message: expect.stringContaining('Invalid API key') })
  })

  it('parses SSE chunks into text + usage chunks', async () => {
    const sseBody =
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":" world"}}]}\n\n' +
      'data: {"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n' +
      'data: [DONE]\n\n'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(sseBody, { status: 200 })))
    const provider = createOpenAIProvider(makeEnv())
    const result = await provider.chat({ messages: [{ role: 'user', content: 'q' }] })
    expect(result.content).toBe('Hello world')
    expect(result.usage).toEqual({
      type: 'usage',
      inputTokens: 5,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    })
  })

  it('routes reasoning_content to thinking (DeepSeek-R1 style)', async () => {
    const sseBody =
      'data: {"choices":[{"delta":{"reasoning_content":"let me think"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"answer"}}]}\n\n' +
      'data: [DONE]\n\n'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(sseBody, { status: 200 })))
    const provider = createOpenAIProvider(makeEnv())
    const result = await provider.chat({ messages: [{ role: 'user', content: 'q' }] })
    expect(result.thinking).toBe('let me think')
    expect(result.content).toBe('answer')
  })

  it('handles chunk-boundary splits (partial lines in buffer)', async () => {
    // Simulate two TCP reads: first half of a chunk, then the rest.
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"conte'))
        controller.enqueue(encoder.encode('nt":"split"}}]}\n\ndata: [DONE]\n\n'))
        controller.close()
      },
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream, { status: 200 })))
    const provider = createOpenAIProvider(makeEnv())
    const result = await provider.chat({ messages: [{ role: 'user', content: 'q' }] })
    expect(result.content).toBe('split')
  })
})