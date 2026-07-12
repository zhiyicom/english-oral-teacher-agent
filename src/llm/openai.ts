import type { Env } from '../config/env.js'
import { getApiKey } from '../config/secrets.js'
import type { ChatChunk, ChatOpts, ChatResult, LLMClient, UsageChunk } from './types.js'

/**
 * v1.0.8 §1.7 — OpenAI-compatible streaming LLM client.
 *
 * Covers any provider that speaks the OpenAI Chat Completions API:
 *   - DeepSeek (https://api.deepseek.com/v1)
 *   - OpenAI (https://api.openai.com/v1)
 *   - OpenRouter (https://openrouter.ai/api/v1)
 *   - Together, Groq, etc.
 *
 * Wire format:
 *   - Auth: `Authorization: Bearer <key>`
 *   - URL: `${baseURL}/chat/completions`
 *   - Stream: SSE chunks of `data: {"choices":[{"delta":{"content":"..."}}]}\n\n`
 *     ending with `data: [DONE]\n\n`.
 *
 * Differences from createAnthropicProvider (src/llm/anthropic.ts):
 *   - Anthropic takes system as a separate top-level parameter; OpenAI
 *     takes it as the first message with role='system'. We collapse any
 *     `systemBlocks` (or fall back to `system`) into one system string and
 *     prepend it to messages.
 *   - Anthropic supports `cache_control: ephemeral`; OpenAI providers have
 *     their own caching (e.g. OpenAI automatic caching) — we don't
 *     annotate breakpoints here.
 *   - Errors come back as `{ error: { message, type } }` JSON in 4xx/5xx
 *     responses. We surface the message via the thrown Error so
 *     classifyLLMError (src/llm/errors.ts) sees the .status and classifies
 *     4xx as non-retryable, 5xx/429 as retryable.
 */

interface OpenAIDelta {
  content?: string | null
  reasoning_content?: string | null
}

interface OpenAIChunk {
  id?: string
  model?: string
  choices?: Array<{
    index?: number
    delta?: OpenAIDelta
    finish_reason?: string | null
  }>
  // DeepSeek / OpenAI stream usage (sent in the last chunk before [DONE]
  // when stream_options.include_usage is true). Anthropic streams usage in
  // `message_start`, so we synthesize a single UsageChunk from this.
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    cached_tokens?: number
  }
}

interface OpenAIErrorBody {
  error?: {
    message?: string
    type?: string
    code?: string | null
  }
}

function buildMessages(opts: ChatOpts): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = []

  const sysText = opts.systemBlocks
    ? opts.systemBlocks.map((b) => b.text).join('\n\n').trim()
    : (opts.system ?? '').trim()

  if (sysText) messages.push({ role: 'system', content: sysText })

  for (const m of opts.messages) {
    // Anthropic provider converts 'system' role to 'user' internally because
    // the Anthropic API has a top-level system field. For OpenAI we don't
    // need that translation — but be defensive in case a caller passes one.
    const role = m.role === 'system' ? 'system' : m.role
    messages.push({ role, content: m.content })
  }
  return messages
}

export function createOpenAIProvider(env: Env): LLMClient {
  const apiKey = getApiKey()
  if (!apiKey) {
    throw new Error(
      'API_KEY not configured. Open http://localhost:<port>/setup to configure, ' +
      'or set API_KEY in .env / process.env.',
    )
  }

  // Strip a trailing slash so `${baseURL}/chat/completions` is well-formed
  // regardless of how the user entered the URL.
  const baseURL = env.ANTHROPIC_BASE_URL.replace(/\/+$/, '')

  async function postChat(body: Record<string, unknown>): Promise<Response> {
    const res = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      // Read the body once for the error message — most providers return JSON
      // { error: { message, type } } but some (Cloudflare gateways, etc.)
      // return plain text. Be permissive.
      const text = await res.text().catch(() => '')
      let message = `HTTP ${res.status}`
      try {
        const parsed = JSON.parse(text) as OpenAIErrorBody
        if (parsed.error?.message) message = parsed.error.message
        else if (text) message = text
      } catch {
        if (text) message = text
      }
      // Attach .status so classifyLLMError() can bucket it (retry vs fail-fast).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const err: Error & { status?: number } = new Error(
        `${res.status} ${message} (api_style=openai, baseURL=${baseURL})`,
      )
      err.status = res.status
      throw err
    }
    return res
  }

  async function* chatStream(opts: ChatOpts): AsyncIterable<ChatChunk> {
    const body: Record<string, unknown> = {
      model: env.LLM_MODEL,
      messages: buildMessages(opts),
      stream: true,
      // Ask the provider to include usage in the final streaming chunk so
      // we can surface it in the UI like Anthropic does. OpenAI requires
      // this opt-in; DeepSeek includes it by default but accepts the flag.
      stream_options: { include_usage: true },
      max_tokens: opts.maxTokens ?? env.LLM_MAX_TOKENS,
      temperature: opts.temperature ?? env.LLM_TEMPERATURE,
    }

    const res = await postChat(body)
    if (!res.body) {
      throw new Error('OpenAI-compatible provider returned no response body')
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder('utf-8')
    // Buffer may straddle chunk boundaries — accumulate partial lines until
    // we hit a \n\n (SSE event terminator) or \n (single-line event).
    let buffer = ''
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        // SSE events are separated by a blank line (\n\n). Split on that
        // first to keep multi-line events intact; within each event, lines
        // start with `data:` (note: `:` then optional space).
        let sepIdx = buffer.indexOf('\n\n')
        while (sepIdx !== -1) {
          const raw = buffer.slice(0, sepIdx)
          buffer = buffer.slice(sepIdx + 2)
          for (const chunk of parseSseEvent(raw)) yield chunk
          sepIdx = buffer.indexOf('\n\n')
        }
      }
      // Flush trailing buffer (some servers omit the final \n\n before close).
      if (buffer.trim()) {
        for (const chunk of parseSseEvent(buffer)) yield chunk
      }
    } finally {
      try {
        reader.releaseLock()
      } catch {
        // ignore — stream may already be released
      }
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

/**
 * Parse one SSE event block (already split on \n\n). Yields zero or more
 * ChatChunks. Silently skips [DONE] and non-JSON / malformed lines.
 */
function* parseSseEvent(raw: string): Generator<ChatChunk, void, void> {
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || !trimmed.startsWith('data:')) continue
    const payload = trimmed.slice(5).trim()
    if (payload === '[DONE]') return

    let parsed: OpenAIChunk
    try {
      parsed = JSON.parse(payload) as OpenAIChunk
    } catch {
      // Heartbeats / partial frames — ignore.
      continue
    }

    if (parsed.usage) {
      const u: UsageChunk = {
        type: 'usage',
        inputTokens: parsed.usage.prompt_tokens ?? 0,
        outputTokens: parsed.usage.completion_tokens ?? 0,
        // OpenAI doesn't expose cached_tokens uniformly; DeepSeek does in
        // `prompt_cache_hit_tokens`. Map `cached_tokens` when present.
        cacheReadTokens: parsed.usage.cached_tokens ?? 0,
        cacheCreationTokens: 0,
      }
      yield u
    }

    const choice = parsed.choices?.[0]
    const delta = choice?.delta
    if (!delta) continue
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      yield { type: 'text', delta: delta.content }
    } else if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
      // DeepSeek-R1 and similar reasoning models put chain-of-thought in
      // `reasoning_content` alongside (or instead of) `content`. Surface
      // it as thinking so the UI can show the CoT panel.
      yield { type: 'thinking', delta: delta.reasoning_content }
    }
  }
}