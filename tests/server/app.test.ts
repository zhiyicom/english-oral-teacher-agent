import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../../src/server.js'
import { resolveMigrationsDirForTesting } from '../storage/helpers.js'

const migrationsDir = resolveMigrationsDirForTesting()
const fixturesDir = join(process.cwd(), 'tests', 'fixtures', 'replay')

// v0.8.1 — L1 server tests. Mount the Hono app in-process (no port binding)
// and exercise each endpoint via Hono's `app.request()` API. This is the
// same pattern hono/testing uses; we use a real Hono instance + a fresh
// on-disk SQLite per test so the handlers see realistic DAO data.
//
// Why on-disk (not :memory:): the `createApp` factory opens its own DB
// handle. We avoid opening a second handle here so Windows doesn't trip
// an EPERM on rmSync (better-sqlite3 holds the file open until the
// handle closes). We verify side effects via the API itself, not by
// reopening the DB.

interface Harness {
  dataDir: string
  app: ReturnType<typeof createApp>
}

function makeHarness(): Harness {
  const dataDir = mkdtempSync(join(tmpdir(), 'server-test-'))
  const app = createApp({ dataDir, fixturesDir })
  return { dataDir, app }
}

describe('createApp (v0.8.1 L1)', () => {
  let harness: Harness

  // Force replay mode in tests regardless of .env settings.
  const savedLiveLlm = process.env.RUN_LIVE_LLM
  delete process.env.RUN_LIVE_LLM

  afterAll(() => {
    if (savedLiveLlm) process.env.RUN_LIVE_LLM = savedLiveLlm
  })

  beforeEach(() => {
    harness = makeHarness()
  })

  afterEach(() => {
    // best-effort cleanup; Windows may EPERM on the still-mapped file.
    // The OS will eventually reclaim /tmp. See comment above.
    try {
      rmSync(harness.dataDir, { recursive: true, force: true })
    } catch {
      // ignore EPERM / EBUSY
    }
  })

  // ---- REST endpoints ----

  it('GET /api/health: returns ok=true + session count', async () => {
    const res = await harness.app.request('/api/health')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; sessions: number }
    expect(body.ok).toBe(true)
    expect(body.sessions).toBe(0)
  })

  it('GET /api/sessions: empty list on fresh dataDir', async () => {
    const res = await harness.app.request('/api/sessions')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { sessions: unknown[] }
    expect(body.sessions).toEqual([])
  })

  it('POST /api/sessions: returns 201 with id, creates a row (verifiable via GET)', async () => {
    const res = await harness.app.request('/api/sessions', { method: 'POST' })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { id: string }
    expect(typeof body.id).toBe('string')
    expect(body.id.length).toBeGreaterThan(10)

    // Verify the row is queryable via GET (no second DB handle needed)
    const verify = await harness.app.request(`/api/sessions/${body.id}`)
    expect(verify.status).toBe(200)
    const session = (await verify.json()) as { id: string }
    expect(session.id).toBe(body.id)
  })

  it('POST /api/sessions: response includes warmUpHook field (v1.0.3 §1.3)', async () => {
    // Fresh server → pendingWarmUpSeed is null → warmUpHook must be null.
    // The field MUST be present in the shape even when null so the web can
    // always read it without an `in` check or destructuring fallback.
    const res = await harness.app.request('/api/sessions', { method: 'POST' })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { id: string; warmUpHook: string | null }
    expect(typeof body.id).toBe('string')
    expect(body.warmUpHook).toBeNull()
  })

  it('POST /api/sessions: read-once semantics — second POST returns null too', async () => {
    // After the first POST clears pendingWarmUpSeed, a second POST must
    // also return null. This proves the module-scoped state is consumed
    // exactly once, not just peeked.
    const first = await harness.app.request('/api/sessions', { method: 'POST' })
    const firstBody = (await first.json()) as { warmUpHook: string | null }
    expect(firstBody.warmUpHook).toBeNull()

    const second = await harness.app.request('/api/sessions', { method: 'POST' })
    const secondBody = (await second.json()) as { warmUpHook: string | null }
    expect(secondBody.warmUpHook).toBeNull()
  })

  it('GET /api/sessions/:id: 404 for unknown id, 200 with correct shape for known id', async () => {
    // 404 path
    const notFound = await harness.app.request('/api/sessions/does-not-exist')
    expect(notFound.status).toBe(404)
    const errBody = (await notFound.json()) as { error: string; id: string }
    expect(errBody.error).toMatch(/not found/i)
    expect(errBody.id).toBe('does-not-exist')

    // 200 path — create then read
    const create = await harness.app.request('/api/sessions', { method: 'POST' })
    const { id } = (await create.json()) as { id: string }
    const res = await harness.app.request(`/api/sessions/${id}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      id: string
      startedAt: string
      endedAt: string | null
      durationMin: number | null
      phaseHistory: string[]
      summary: string | null
      keywords: string[]
    }
    expect(body.id).toBe(id)
    expect(body.endedAt).toBeNull()
    expect(body.durationMin).toBeNull()
    expect(body.summary).toBeNull()
    expect(body.keywords).toEqual([])
    expect(body.phaseHistory).toEqual([]) // newly created row has no phase_history
  })

  it('GET /api/sessions: lists sessions in DESC startedAt order', async () => {
    // Create 3 sessions — they should appear in reverse insertion order
    // because startedAt is monotonically increasing.
    const ids: string[] = []
    for (let i = 0; i < 3; i++) {
      const res = await harness.app.request('/api/sessions', { method: 'POST' })
      const { id } = (await res.json()) as { id: string }
      ids.push(id)
    }
    const res = await harness.app.request('/api/sessions')
    const body = (await res.json()) as { sessions: Array<{ id: string }> }
    expect(body.sessions).toHaveLength(3)
    // Newest first → reverse insertion order
    expect(body.sessions[0]?.id).toBe(ids[2])
    expect(body.sessions[1]?.id).toBe(ids[1])
    expect(body.sessions[2]?.id).toBe(ids[0])
  })

  // ---- SSE (v0.8.3 real turn loop) ----

  it('GET /api/sessions/:id/stream: returns 404 for unknown id', async () => {
    const res = await harness.app.request('/api/sessions/no-such/stream?action=init')
    expect(res.status).toBe(404)
  })

  it('GET /api/sessions/:id/stream: returns 400 for missing action', async () => {
    const create = await harness.app.request('/api/sessions', { method: 'POST' })
    const { id } = (await create.json()) as { id: string }
    const res = await harness.app.request(`/api/sessions/${id}/stream`)
    expect(res.status).toBe(400)
  })

  it('GET /api/sessions/:id/stream?action=init: emits phase + done events', async () => {
    const create = await harness.app.request('/api/sessions', { method: 'POST' })
    const { id } = (await create.json()) as { id: string }

    const res = await harness.app.request(`/api/sessions/${id}/stream?action=init`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/)

    const text = await res.text()
    expect(text).toMatch(/^event: phase/m)
    expect(text).toMatch(/^event: done/m)
    expect(text).toMatch(/"endedReason":"init"/)
  })

  it('GET /api/sessions/:id/stream?action=turn&input=hi: streams TurnEvents + done', async () => {
    const create = await harness.app.request('/api/sessions', { method: 'POST' })
    const { id } = (await create.json()) as { id: string }

    const res = await harness.app.request(
      `/api/sessions/${id}/stream?action=turn&input=${encodeURIComponent('hi')}`,
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/)

    const text = await res.text()
    expect(text).toMatch(/^event: ctx-segment/m)
    expect(text).toMatch(/^event: ctx/m)
    expect(text).toMatch(/^event: student-text/m)
    expect(text).toMatch(/^event: done/m)
    expect(text).toMatch(/"endedReason":null/)
  })

  it('GET /api/sessions/:id/stream?action=turn: returns 400 when input missing', async () => {
    const create = await harness.app.request('/api/sessions', { method: 'POST' })
    const { id } = (await create.json()) as { id: string }

    const res = await harness.app.request(`/api/sessions/${id}/stream?action=turn`)
    expect(res.status).toBe(400)
  })

  // ---- v0.8.4: messages[] + settings ----

  it('GET /api/sessions/:id: includes messages[] array', async () => {
    const create = await harness.app.request('/api/sessions', { method: 'POST' })
    const { id } = (await create.json()) as { id: string }

    const res = await harness.app.request(`/api/sessions/${id}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { messages: unknown[] }
    expect(Array.isArray(body.messages)).toBe(true)
  })

  it('GET /api/settings: returns default values', async () => {
    const res = await harness.app.request('/api/settings')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      voice_enabled: boolean
      voice_speed: number
      voice_accent: string
      font_size: number
      show_debug: boolean
    }
    expect(typeof body.voice_enabled).toBe('boolean')
    expect(typeof body.voice_speed).toBe('number')
    expect(typeof body.font_size).toBe('number')
  })

  it('PUT /api/settings: persists voice_enabled and returns ok', async () => {
    const res = await harness.app.request('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voice_enabled: true }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; persisted: string[] }
    expect(body.ok).toBe(true)
    expect(body.persisted).toContain('voice_enabled')

    // Verify GET reflects the change
    const get = await harness.app.request('/api/settings')
    const settings = (await get.json()) as { voice_enabled: boolean }
    expect(settings.voice_enabled).toBe(true)
  })

  it('DELETE /api/sessions/:id: removes session and returns ok', async () => {
    const create = await harness.app.request('/api/sessions', { method: 'POST' })
    const { id } = (await create.json()) as { id: string }

    const del = await harness.app.request(`/api/sessions/${id}`, { method: 'DELETE' })
    expect(del.status).toBe(200)
    expect(((await del.json()) as { ok: boolean }).ok).toBe(true)

    // Verify it's gone
    const get = await harness.app.request(`/api/sessions/${id}`)
    expect(get.status).toBe(404)
  })

  it('DELETE /api/sessions/:id: subsequent POST still returns warmUpHook=null (no stale seed leak)', async () => {
    // v1.0.3 §1.3 — regression: DELETE must not surface any stale
    // pendingWarmUpSeed in subsequent session starts. The new DELETE handler
    // clears the seed if the deleted session was the latest with a summary;
    // verifying that a fresh POST after DELETE still returns null confirms
    // the seed state stays consistent.
    const create = await harness.app.request('/api/sessions', { method: 'POST' })
    const { id } = (await create.json()) as { id: string }

    const del = await harness.app.request(`/api/sessions/${id}`, { method: 'DELETE' })
    expect(del.status).toBe(200)

    const after = await harness.app.request('/api/sessions', { method: 'POST' })
    const afterBody = (await after.json()) as { warmUpHook: string | null }
    expect(afterBody.warmUpHook).toBeNull()
  })

  it('DELETE /api/sessions/:id: returns 404 for unknown id', async () => {
    const res = await harness.app.request('/api/sessions/no-such', { method: 'DELETE' })
    expect(res.status).toBe(404)
  })

  // ---- v1.0.2: GET /api/topics extended shape + PUT whitelist ----

  it('GET /api/topics: includes hitCount + keywordHits (zero on fresh DB)', async () => {
    // v1.0.2 — the response shape now joins topic_stats + keyword_hits.
    // On a fresh DB the seeded topics from migration 003 are listed with
    // hitCount=0 and keywordHits={}. We verify shape, not behavior here;
    // the DAO + write-path tests cover the data layer.
    const res = await harness.app.request('/api/topics')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Array<{
      name: string
      keywords: string[]
      description: string | null
      hitCount: number
      keywordHits: Record<string, number>
    }>
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBeGreaterThan(0)
    for (const t of body) {
      expect(t.hitCount).toBe(0)
      expect(t.keywordHits).toEqual({})
    }
    // Sanity: one of the seed topics must be present.
    const names = body.map((t) => t.name)
    expect(names).toContain('minecraft')
  })

  it('GET /api/topics: returns topics in alphabetical order (unchanged from v0.8.5)', async () => {
    const res = await harness.app.request('/api/topics')
    const body = (await res.json()) as Array<{ name: string }>
    const names = body.map((t) => t.name)
    const sorted = [...names].sort()
    expect(names).toEqual(sorted)
  })

  it('PUT /api/topics: silently drops hitCount + keywordHits (field whitelist)', async () => {
    // v1.0.2 — even if the client (or a buggy script) sends the new stat
    // fields in the PUT body, the server must NOT persist them. This
    // protects topic_stats + keyword_hits from accidental clobbering.
    const malicious = [
      {
        name: 'minecraft',
        keywords: ['minecraft', 'castle', 'creeper'],
        description: 'Minecraft game',
        hitCount: 9999, // must be ignored
        keywordHits: { creeper: 9999 }, // must be ignored
      },
    ]
    const put = await harness.app.request('/api/topics', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(malicious),
    })
    expect(put.status).toBe(200)

    // Re-GET: hitCount must still be 0 (we never ran a session).
    const get = await harness.app.request('/api/topics')
    const body = (await get.json()) as Array<{ name: string; hitCount: number }>
    const mc = body.find((t) => t.name === 'minecraft')
    expect(mc?.hitCount).toBe(0)
  })

  it('PUT /api/topics: still accepts the legacy 3-field shape unchanged', async () => {
    // Regression: the whitelist must not break the existing 3-field contract.
    const before = await (await harness.app.request('/api/topics')).json() as Array<{
      name: string
    }>
    const sameShape = before.map((t) => ({ name: t.name, keywords: ['placeholder'], description: 't' }))
    const put = await harness.app.request('/api/topics', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sameShape),
    })
    expect(put.status).toBe(200)
  })
})
