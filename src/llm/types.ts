export type Role = 'system' | 'user' | 'assistant'

export interface Message {
  role: Role
  content: string
}

/**
 * Anthropic-compatible text block for the system prompt. v0.7.5 added
 * `cache_control` so the CLI can mark the static SOUL+AGENTS+USER portion
 * as ephemeral-cached (huge cost reduction on long sessions). SDK 0.41
 * only supports `ephemeral`; `persistent` is not exposed in the current
 * type defs, so we narrow to just that value here.
 */
export type SystemBlock = {
  type: 'text'
  text: string
  cache_control?: { type: 'ephemeral' }
}

export interface ChatOpts {
  /** Legacy: pass a single string. No cache_control applied. */
  system?: string
  /** v0.7.5+: pass an array of text blocks. First block can carry cache_control. */
  systemBlocks?: SystemBlock[]
  messages: Message[]
  temperature?: number
  maxTokens?: number
}

/**
 * Token usage chunk, yielded by `chatStream` exactly once at the start of
 * the stream (mirroring Anthropic's `message_start` event). v0.7.5.
 */
export interface UsageChunk {
  type: 'usage'
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

export type ChatChunk =
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | UsageChunk

export interface ChatResult {
  content: string
  thinking?: string
  /** v0.7.5: populated from `message_start.message.usage`; absent if provider didn't report. */
  usage?: UsageChunk
}

export interface LLMClient {
  chatStream(opts: ChatOpts): AsyncIterable<ChatChunk>
  chat(opts: ChatOpts): Promise<ChatResult>
}
