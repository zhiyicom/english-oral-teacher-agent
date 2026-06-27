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

export async function createSession(): Promise<{ id: string }> {
  const res = await checkOk(
    await fetch(`${BASE}/api/sessions`, { method: 'POST' }),
    'createSession',
  )
  return (await res.json()) as { id: string }
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

// v0.8.3 — build the SSE stream URL for a session turn.
// Each turn opens a fresh EventSource connection with query params.
export function getSessionStreamUrl(
  sessionId: string,
  action: 'init' | 'turn',
  input?: string,
): string {
  const params = new URLSearchParams({ action })
  if (input) params.set('input', input)
  return `${BASE}/api/sessions/${encodeURIComponent(sessionId)}/stream?${params}`
}
