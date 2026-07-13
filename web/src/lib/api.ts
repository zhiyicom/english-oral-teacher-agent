import type { SessionApi } from './types'

// BASE is empty: in dev Vite proxies /api/* → http://localhost:3000,
// and in production the browser hits the same origin (server.ts serves
// web/dist/ as static + SPA fallback in v0.8.5+).
// Empty BASE means CORS never arises — every fetch stays on its own origin.
const BASE = ''

async function checkOk(res: Response, label: string): Promise<Response> {
  if (!res.ok) {
    throw new Error(`${label}: HTTP ${res.status}`)
  }
  return res
}

export async function listSessions(): Promise<SessionApi[]> {
  const res = await checkOk(await fetch(`${BASE}/api/sessions`), 'listSessions')
  const body = (await res.json()) as { sessions: SessionApi[] }
  return body.sessions
}

export async function createSession(): Promise<{ id: string; warmUpHook: string | null }> {
  const res = await checkOk(
    await fetch(`${BASE}/api/sessions`, { method: 'POST' }),
    'createSession',
  )
  return (await res.json()) as { id: string; warmUpHook: string | null }
}

export async function getSession(id: string): Promise<SessionApi> {
  const res = await checkOk(
    await fetch(`${BASE}/api/sessions/${encodeURIComponent(id)}`),
    'getSession',
  )
  return (await res.json()) as SessionApi
}

// v0.8.4 — settings endpoints
export async function getSettings(): Promise<import('./types').SettingsApi> {
  const res = await checkOk(await fetch(`${BASE}/api/settings`), 'getSettings')
  return (await res.json()) as import('./types').SettingsApi
}

export async function updateSettings(
  updates: Partial<import('./types').SettingsApi>,
): Promise<{ ok: boolean; persisted: string[] }> {
  const res = await checkOk(
    await fetch(`${BASE}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    }),
    'updateSettings',
  )
  return (await res.json()) as { ok: boolean; persisted: string[] }
}

export async function deleteSession(id: string): Promise<void> {
  const res = await fetch(`${BASE}/api/sessions/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
  if (!res.ok) throw new Error(`deleteSession: HTTP ${res.status}`)
}

// v1.0.2 — GET /api/topics joins topic_stats + keyword_hits.
// - hitCount: per-topic discussion_count (0 included).
// - keywordHits: Record<keyword, hit_count> for keywords with ≥1 hit;
//   missing keywords are implicit 0.
export interface TopicApi {
  name: string
  keywords: string[]
  description: string
  hitCount: number
  keywordHits: Record<string, number>
}

export async function getTopics(): Promise<TopicApi[]> {
  const res = await checkOk(await fetch(`${BASE}/api/topics`), 'getTopics')
  return (await res.json()) as TopicApi[]
}

export async function updateTopics(topics: TopicApi[]): Promise<void> {
  await checkOk(
    await fetch(`${BASE}/api/topics`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(topics),
    }),
    'updateTopics',
  )
}

// v1.0.6 §1.6 — /setup wizard helpers
export interface SetupStatus {
  needsApiKey: boolean
  hasUserProfile: boolean
  baseUrl: string
  model: string
  appDataDir: string
  version: string
}

export interface ProfileDefault {
  name: string
  age: number
  level: string
  goals: string[]
  interests: string[]
}

export async function getSetupStatus(): Promise<SetupStatus> {
  const res = await fetch(`${BASE}/api/setup/status`)
  if (!res.ok) throw new Error(`getSetupStatus: HTTP ${res.status}`)
  return (await res.json()) as SetupStatus
}

export async function getProfileDefault(): Promise<ProfileDefault> {
  const res = await fetch(`${BASE}/api/setup/profile-default`)
  if (!res.ok) throw new Error(`getProfileDefault: HTTP ${res.status}`)
  return (await res.json()) as ProfileDefault
}

export async function saveApiKey(opts: {
  apiKey: string
  baseUrl?: string
  model?: string
}): Promise<{ ok: boolean; persisted: string[] }> {
  const res = await fetch(`${BASE}/api/setup/api-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  })
  if (!res.ok) throw new Error((await res.json()).error ?? `saveApiKey: HTTP ${res.status}`)
  return (await res.json()) as { ok: boolean; persisted: string[] }
}

export async function saveProfile(profile: {
  name: string
  age: number
  level: string
  goals: string[]
  interests: string[]
}): Promise<{ ok: boolean }> {
  const res = await fetch(`${BASE}/api/setup/profile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(profile),
  })
  if (!res.ok) throw new Error((await res.json()).error ?? `saveProfile: HTTP ${res.status}`)
  return (await res.json()) as { ok: boolean }
}

// v0.8.3 — build the SSE stream URL for a session turn.
// Each turn opens a fresh EventSource connection with query params.
// v1.0.3 §1.3 — optionally include `warmUpHook` (LLM-curated opener
// keyword from previous session's profile-extract). Server only uses it
// on the first turn; later turns ignore the value.
export function getSessionStreamUrl(
  sessionId: string,
  action: 'init' | 'turn',
  input?: string,
  warmUpHook?: string | null,
): string {
  const params = new URLSearchParams({ action })
  if (input) params.set('input', input)
  if (warmUpHook && warmUpHook.trim().length > 0) {
    params.set('warmUpHook', warmUpHook.trim())
  }
  return `${BASE}/api/sessions/${encodeURIComponent(sessionId)}/stream?${params}`
}
