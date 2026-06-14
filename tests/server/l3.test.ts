import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const SERVER_PATH = resolve('src/server.ts')
const NODE_PATH = process.execPath

interface ServerHandle {
  child: ChildProcessWithoutNullStreams
  port: number
  dataDir: string
  kill(): Promise<void>
}

// Pick a random-ish port in 10000-19999 so concurrent test runs don't
// collide with each other (each test gets a different ephemeral port).
function pickPort(): number {
  return 10000 + Math.floor(Math.random() * 9999)
}

function safeRm(dir: string): void {
  for (let i = 0; i < 3; i++) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      return
    } catch (err) {
      if (i === 2) {
        console.warn(`[server-l3.test] cleanup warning: ${(err as Error).message}`)
      }
    }
  }
}

async function spawnServer(): Promise<ServerHandle> {
  const dataDir = mkdtempSync(join(tmpdir(), 'server-l3-'))
  const port = pickPort()
  const child: ChildProcessWithoutNullStreams = spawn(NODE_PATH, ['--import', 'tsx', SERVER_PATH], {
    env: {
      ...process.env,
      // Required by env validation; real key not used in Replay mode.
      MINIMAX_API_KEY: 'sk-test',
      APP_DATA_DIR: dataDir,
      PORT: String(port),
      RUN_LIVE_LLM: '0', // force replay mode in tests
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  // Wait for the "[server] listening on" line so we know the port is bound.
  // On Windows, startup is typically 1-3s; 5s is plenty for a fresh spawn.
  await new Promise<void>((res, rej) => {
    const timer = setTimeout(() => {
      rej(new Error('server startup timeout (5s)'))
    }, 5000)
    child.stdout.on('data', (d) => {
      const s = d.toString()
      if (s.includes('listening on')) {
        clearTimeout(timer)
        res()
      }
    })
    child.stderr.on('data', () => {
      // swallow — startup errors would surface as timeout
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      rej(err)
    })
  })

  return {
    child,
    port,
    dataDir,
    async kill() {
      child.kill('SIGTERM')
      await new Promise<void>((res) => {
        child.on('close', () => res())
        setTimeout(() => res(), 2000) // force-resolve on hang
      })
    },
  }
}

describe('Server end-to-end (v0.8.1 L3 — spawn + curl)', () => {
  let server: ServerHandle | null = null

  beforeEach(async () => {
    server = await spawnServer()
  })

  afterEach(async () => {
    if (server) {
      await server.kill()
      safeRm(server.dataDir)
      server = null
    }
  })

  it('GET /api/health returns ok=true on a live process', async () => {
    const base = `http://127.0.0.1:${server?.port}`
    const res = await fetch(`${base}/api/health`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; sessions: number }
    expect(body.ok).toBe(true)
    expect(body.sessions).toBe(0)
  })

  it('POST /api/sessions + GET /api/sessions/:id round-trips an id through the live process', async () => {
    const base = `http://127.0.0.1:${server?.port}`
    const create = await fetch(`${base}/api/sessions`, { method: 'POST' })
    expect(create.status).toBe(201)
    const { id } = (await create.json()) as { id: string }

    const get = await fetch(`${base}/api/sessions/${id}`)
    expect(get.status).toBe(200)
    const session = (await get.json()) as { id: string; endedAt: string | null }
    expect(session.id).toBe(id)
    expect(session.endedAt).toBeNull()
  })

  it('GET /api/sessions/:id returns 404 for unknown id', async () => {
    const base = `http://127.0.0.1:${server?.port}`
    const res = await fetch(`${base}/api/sessions/no-such-id`)
    expect(res.status).toBe(404)
  })

  it('GET /api/sessions/:id/stream?action=turn&input=hi streams real TurnEvents', async () => {
    const base = `http://127.0.0.1:${server?.port}`
    const create = await fetch(`${base}/api/sessions`, { method: 'POST' })
    const { id } = (await create.json()) as { id: string }

    const res = await fetch(
      `${base}/api/sessions/${id}/stream?action=turn&input=${encodeURIComponent('hi')}`,
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

  it('GET /api/sessions/:id/stream?action=turn returns 400 when input missing', async () => {
    const base = `http://127.0.0.1:${server?.port}`
    const create = await fetch(`${base}/api/sessions`, { method: 'POST' })
    const { id } = (await create.json()) as { id: string }

    const res = await fetch(`${base}/api/sessions/${id}/stream?action=turn`)
    expect(res.status).toBe(400)
  })

  it('GET /api/sessions/:id/stream returns 404 for unknown id', async () => {
    const base = `http://127.0.0.1:${server?.port}`
    const res = await fetch(`${base}/api/sessions/no-such/stream?action=init`)
    expect(res.status).toBe(404)
  })

  it('PUT /api/settings persists voice_enabled across server restart', async () => {
    const base = `http://127.0.0.1:${server?.port}`

    // Save original value first
    const orig = await fetch(`${base}/api/settings`)
    const origSettings = (await orig.json()) as { voice_enabled: boolean }
    const originalValue = origSettings.voice_enabled

    // Set voice_enabled to the opposite
    const newValue = !originalValue
    const put = await fetch(`${base}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voice_enabled: newValue }),
    })
    expect(put.status).toBe(200)

    // Verify immediately
    const get1 = await fetch(`${base}/api/settings`)
    const s1 = (await get1.json()) as { voice_enabled: boolean }
    expect(s1.voice_enabled).toBe(newValue)

    // Restart server
    await server?.kill()
    server = await spawnServer()

    // Verify persistence
    const base2 = `http://127.0.0.1:${server?.port}`
    const get2 = await fetch(`${base2}/api/settings`)
    const s2 = (await get2.json()) as { voice_enabled: boolean }
    expect(s2.voice_enabled).toBe(newValue)

    // Restore original value
    await fetch(`${base2}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voice_enabled: originalValue }),
    })
  })
})
