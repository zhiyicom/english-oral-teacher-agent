import { describe, expect, it } from 'vitest'
import { type ClassifiedError, classifyLLMError } from '../../src/llm/errors.js'

function makeAnthropicError(status: number, message = 'mock'): Error & { status: number } {
  const e = new Error(message) as Error & { status: number }
  e.status = status
  return e
}

describe('classifyLLMError', () => {
  it('classifies 429 as rate_limit (retryable)', () => {
    const result = classifyLLMError(makeAnthropicError(429))
    expect(result.classification).toBe('rate_limit')
    expect(result.retryable).toBe(true)
    expect(result.original.message).toBe('mock')
  })

  it('classifies 500 as 5xx (retryable)', () => {
    const result = classifyLLMError(makeAnthropicError(500))
    expect(result.classification).toBe('5xx')
    expect(result.retryable).toBe(true)
  })

  it('classifies 503 as 5xx (retryable)', () => {
    const result = classifyLLMError(makeAnthropicError(503))
    expect(result.classification).toBe('5xx')
    expect(result.retryable).toBe(true)
  })

  it('classifies 400 as 4xx (not retryable)', () => {
    const result = classifyLLMError(makeAnthropicError(400))
    expect(result.classification).toBe('4xx')
    expect(result.retryable).toBe(false)
  })

  it('classifies 401 as 4xx (not retryable) — bad API key', () => {
    const result = classifyLLMError(makeAnthropicError(401))
    expect(result.classification).toBe('4xx')
    expect(result.retryable).toBe(false)
  })

  it('classifies 404 as 4xx (not retryable) — bad model', () => {
    const result = classifyLLMError(makeAnthropicError(404))
    expect(result.classification).toBe('4xx')
    expect(result.retryable).toBe(false)
  })

  it('classifies TypeError (no .status) as network (retryable)', () => {
    // fetch() throws TypeError on DNS / connection refused
    const result = classifyLLMError(new TypeError('fetch failed'))
    expect(result.classification).toBe('network')
    expect(result.retryable).toBe(true)
  })

  it('classifies ECONNRESET-like error as network (retryable)', () => {
    const e = new Error('read ECONNRESET') as Error & { code: string }
    e.code = 'ECONNRESET'
    const result = classifyLLMError(e)
    expect(result.classification).toBe('network')
    expect(result.retryable).toBe(true)
  })

  it('classifies non-Error throw as unknown (not retryable)', () => {
    const result = classifyLLMError('something went wrong')
    expect(result.classification).toBe('unknown')
    expect(result.retryable).toBe(false)
    // Non-Error thrown values get wrapped into a real Error.
    expect(result.original).toBeInstanceOf(Error)
  })

  it('classifies null throw as unknown (not retryable)', () => {
    const result = classifyLLMError(null)
    expect(result.classification).toBe('unknown')
    expect(result.retryable).toBe(false)
  })

  it('classifies 600 (out of HTTP range) as unknown (not retryable)', () => {
    const result = classifyLLMError(makeAnthropicError(600))
    expect(result.classification).toBe('unknown')
    expect(result.retryable).toBe(false)
  })

  it('preserves original Error message in the result', () => {
    const result = classifyLLMError(makeAnthropicError(500, 'Service Unavailable'))
    expect(result.original.message).toBe('Service Unavailable')
  })
})
