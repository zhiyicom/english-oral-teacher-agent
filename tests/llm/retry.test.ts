import { describe, expect, it, vi } from 'vitest'
import { chatStreamWithRetry } from '../../src/llm/retry.js'
import type { ChatOpts, LLMClient, UsageChunk } from '../../src/llm/types.js'

/**
 * v0.7.6 L1 tests for `chatStreamWithRetry`.
 *
 * Covers the A-axis retry policy:
 *   - Happy path: no error → returns on first attempt
 *   - 429 / 5xx / network: retry once, then succeed
 *   - 429 / 5xx / network: retry once, then fail (maxAttempts=2 → throws)
 *   - 4xx / unknown: fail fast (no retry, throws on first attempt)
 *   - maxAttempts=1 disables retry (no waiting)
 *   - maxAttempts=0 throws at construction
 *   - onAttempt callback fires once per failed attempt
 *
 * The wrapper logs to stderr — tests redirect it to keep test output clean.
 */

function makeSuccessClient(text = 'hello world', usage?: UsageChunk): LLMClient {
  return {
    async *chatStream(_opts: ChatOpts) {
      if (usage) yield usage
      yield { type: 'text', delta: text }
    },
    async chat(_opts: ChatOpts) {
      return { content: text }
    },
  }
}

function makeFailingClient(err: unknown, failAttempts: number): LLMClient {
  let calls = 0
  return {
    async *chatStream(_opts: ChatOpts) {
      calls += 1
      if (calls <= failAttempts) {
        throw err
      }
      yield { type: 'text', delta: 'recovered' }
    },
    async chat(_opts: ChatOpts) {
      return { content: 'recovered' }
    },
  }
}

function makeAnthropicError(status: number, message = 'mock'): Error & { status: number } {
  const e = new Error(message) as Error & { status: number }
  e.status = status
  return e
}

describe('chatStreamWithRetry', () => {
  // Silence the wrapper's stderr logging during tests.
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

  it('returns the first-attempt response when chatStream yields text', async () => {
    const client = makeSuccessClient('hi there')
    const result = await chatStreamWithRetry(client, { messages: [] })
    expect(result.response).toBe('hi there')
    expect(result.usage).toBeNull()
  })

  it('captures the usage chunk if yielded before text', async () => {
    const usage: UsageChunk = {
      type: 'usage',
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    }
    const client = makeSuccessClient('ok', usage)
    const result = await chatStreamWithRetry(client, { messages: [] })
    expect(result.response).toBe('ok')
    expect(result.usage).toEqual(usage)
  })

  it('429 (rate_limit) on attempt 1 + success on attempt 2 → returns recovered text', async () => {
    const err = makeAnthropicError(429, 'rate limited')
    const client = makeFailingClient(err, 1)
    const result = await chatStreamWithRetry(client, { messages: [] })
    expect(result.response).toBe('recovered')
  })

  it('500 (5xx) twice in a row → throws (maxAttempts=2 exhausted)', async () => {
    const err = makeAnthropicError(500, 'server error')
    const client = makeFailingClient(err, 5) // always fails
    await expect(chatStreamWithRetry(client, { messages: [] })).rejects.toBe(err)
  })

  it('500 on attempt 1, success on attempt 2 → returns recovered', async () => {
    const err = makeAnthropicError(503, 'unavailable')
    const client = makeFailingClient(err, 1)
    const result = await chatStreamWithRetry(client, { messages: [] })
    expect(result.response).toBe('recovered')
  })

  it('network error (TypeError) on attempt 1 + success on attempt 2 → recovered', async () => {
    const err = new TypeError('fetch failed')
    const client = makeFailingClient(err, 1)
    const result = await chatStreamWithRetry(client, { messages: [] })
    expect(result.response).toBe('recovered')
  })

  it('4xx (401, bad key) on attempt 1 → throws immediately (no retry)', async () => {
    const err = makeAnthropicError(401, 'unauthorized')
    let callCount = 0
    const client: LLMClient = {
      async *chatStream(_opts: ChatOpts) {
        callCount += 1
        // biome-ignore lint/correctness/useYield: throw-only iterator
        throw err
      },
      async chat(_opts: ChatOpts) {
        return { content: '' }
      },
    }
    await expect(chatStreamWithRetry(client, { messages: [] })).rejects.toBe(err)
    expect(callCount).toBe(1) // fail-fast, no retry
  })

  it('unknown error (non-Error throw) → throws immediately, no retry', async () => {
    let callCount = 0
    const client: LLMClient = {
      async *chatStream(_opts: ChatOpts) {
        callCount += 1
        // biome-ignore lint/suspicious/noExplicitAny: testing non-Error throw
        // biome-ignore lint/correctness/useYield: throw-only iterator
        throw 'something broke' as any
      },
      async chat(_opts: ChatOpts) {
        return { content: '' }
      },
    }
    await expect(chatStreamWithRetry(client, { messages: [] })).rejects.toBe('something broke')
    expect(callCount).toBe(1)
  })

  it('maxAttempts=1 disables retry (single attempt then throw)', async () => {
    const err = makeAnthropicError(503, 'unavailable')
    let callCount = 0
    const client: LLMClient = {
      async *chatStream(_opts: ChatOpts) {
        callCount += 1
        // biome-ignore lint/correctness/useYield: throw-only iterator
        throw err
      },
      async chat(_opts: ChatOpts) {
        return { content: '' }
      },
    }
    await expect(chatStreamWithRetry(client, { messages: [] }, 1)).rejects.toBe(err)
    expect(callCount).toBe(1)
  })

  it('maxAttempts=3 with 5xx on attempts 1+2 + success on 3 → recovered', async () => {
    const err = makeAnthropicError(500, 'transient')
    const client = makeFailingClient(err, 2) // first 2 fail, 3rd succeeds
    const result = await chatStreamWithRetry(client, { messages: [] }, 3)
    expect(result.response).toBe('recovered')
  })

  it('maxAttempts=0 throws at construction (defensive)', async () => {
    const client = makeSuccessClient('hi')
    await expect(chatStreamWithRetry(client, { messages: [] }, 0)).rejects.toThrow(
      /maxAttempts must be >= 1/,
    )
  })

  it('onAttempt callback fires once per failed attempt', async () => {
    const err = makeAnthropicError(500)
    const client = makeFailingClient(err, 2) // attempts 1+2 fail, 3rd succeeds
    const callback = vi.fn()
    await chatStreamWithRetry(client, { messages: [] }, 3, callback)
    expect(callback).toHaveBeenCalledTimes(2)
    expect(callback).toHaveBeenNthCalledWith(1, 1, err)
    expect(callback).toHaveBeenNthCalledWith(2, 2, err)
  })

  it('logs the error classification to stderr', async () => {
    const err = makeAnthropicError(429, 'slow down')
    const client = makeFailingClient(err, 1)
    stderrSpy.mockClear()
    await chatStreamWithRetry(client, { messages: [] })
    const calls = stderrSpy.mock.calls.flat().join('')
    expect(calls).toMatch(/\[cli\] llm error: rate_limit/)
    expect(calls).toMatch(/\[cli\] retrying in 1s\.\.\. \(attempt 2\/2\)/)
  })

  it('non-retryable (4xx) does NOT log the "retrying in" line', async () => {
    const err = makeAnthropicError(401)
    const client = makeFailingClient(err, 1)
    stderrSpy.mockClear()
    await expect(chatStreamWithRetry(client, { messages: [] })).rejects.toBe(err)
    const calls = stderrSpy.mock.calls.flat().join('')
    expect(calls).toMatch(/\[cli\] llm error: 4xx/)
    expect(calls).not.toMatch(/retrying in/)
  })
})
