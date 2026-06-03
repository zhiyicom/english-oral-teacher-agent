export type Role = 'system' | 'user' | 'assistant'

export interface Message {
  role: Role
  content: string
}

export interface ChatOpts {
  system: string
  messages: Message[]
  temperature?: number
  maxTokens?: number
}

export type ChatChunk = { type: 'text'; delta: string } | { type: 'thinking'; delta: string }

export interface ChatResult {
  content: string
  thinking?: string
  usage?: { inputTokens: number; outputTokens: number }
}

export interface LLMClient {
  chatStream(opts: ChatOpts): AsyncIterable<ChatChunk>
  chat(opts: ChatOpts): Promise<ChatResult>
}
