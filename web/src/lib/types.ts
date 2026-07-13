// Mirror of `SessionApi` interface in src/server.ts. Keep in sync manually
// until v0.8.5+ extracts to a shared package. camelCase per v0.8-design §3.1.
export interface SessionApi {
  id: string
  startedAt: string
  endedAt: string | null
  durationMin: number | null
  phaseHistory: string[]
  summary: string | null
  keywords: string[]
  topicMatch: string | null
  messages?: SessionMessage[] // v0.8.4 — only in GET /api/sessions/:id
}

export interface SessionMessage {
  id: number
  role: 'user' | 'assistant' | 'system'
  content: string
  ts: string
}

// v0.8.4 — settings shape from GET/PUT /api/settings
export interface SettingsApi {
  voice_enabled: boolean
  voice_speed: number
  voice_accent: string
  // v1.0.8 §1.1 — TTS 语音源：本地 OneCore vs 在线云端
  voice_source: 'local' | 'online'
  // v1.0.8 §1.7 — LLM 协议：Anthropic 兼容 vs OpenAI 兼容
  api_style: 'anthropic' | 'openai'
  font_size: number
  show_debug: boolean
  mic_hotkey: Record<string, unknown> | null
  send_hotkey: Record<string, unknown> | null
  base_url: string
  model: string
  api_key?: string
}

// v0.8.3 — SSE event types consumed by SessionPage.
export interface SSEMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  ts: string
}

export type SSEEvent =
  | { type: 'phase'; phase: string; elapsed: number; silence: number; reason: string }
  | { type: 'ctx'; phase: string; elapsed: number; silence: number }
  | { type: 'student-text'; text: string }
  | { type: 'done'; endedReason: string | null }
  | { type: 'error'; classification: string; message: string }
