/**
 * LLM error classification. v0.7.6.
 *
 * Anthropic SDK throws `APIError` with a `.status` field (HTTP code). We
 * classify into 5 buckets so the CLI can decide retry vs fallback:
 *
 *   - rate_limit (429) — retryable; transient
 *   - 5xx           — retryable; server-side problem
 *   - 4xx           — NOT retryable; client error (bad key, bad model, etc.)
 *   - network       — retryable; fetch/TCP failure (no .status)
 *   - unknown       — NOT retryable; nothing matched
 *
 * Per v0.7.6 scope §2.1 A, retry budget is 1 (i.e. 1 initial + 1 retry =
 * maxAttempts=2). Content-filter refusal is detected separately (in the
 * response, not the thrown error) and is NOT classified here.
 */

export type LLMErrorClass = 'rate_limit' | '5xx' | '4xx' | 'network' | 'unknown'

export interface ClassifiedError {
  classification: LLMErrorClass
  /** True if retrying once is worth attempting. */
  retryable: boolean
  original: Error
}

const RETRYABLE: ReadonlySet<LLMErrorClass> = new Set(['rate_limit', '5xx', 'network'])

interface ErrorWithStatus {
  status?: unknown
  code?: unknown
  message?: unknown
}

function hasStatus(err: unknown): err is Error & { status: number } {
  if (!err || typeof err !== 'object') return false
  const status = (err as ErrorWithStatus).status
  return typeof status === 'number' && Number.isFinite(status)
}

export function classifyLLMError(err: unknown): ClassifiedError {
  if (err instanceof Error) {
    if (hasStatus(err)) {
      const status = err.status
      let cls: LLMErrorClass
      if (status === 429) cls = 'rate_limit'
      else if (status >= 500 && status <= 599) cls = '5xx'
      else if (status >= 400 && status <= 499) cls = '4xx'
      else cls = 'unknown'
      return { classification: cls, retryable: RETRYABLE.has(cls), original: err }
    }
    // Error without .status → fetch / TCP / DNS / AbortError / etc. — retryable.
    // TypeError is what fetch throws on DNS / connection refused.
    return { classification: 'network', retryable: true, original: err }
  }
  // Non-Error throw (string, null, undefined, object literal) — not a
  // recognizable network failure; treat as unknown to avoid masking
  // programmer errors with retry storms.
  return {
    classification: 'unknown',
    retryable: false,
    original: new Error(typeof err === 'string' ? err : `Non-Error thrown: ${String(err)}`),
  }
}
