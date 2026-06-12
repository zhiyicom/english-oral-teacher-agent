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
