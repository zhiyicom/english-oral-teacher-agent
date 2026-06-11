// src/server.ts
// v0.8.1 — HTTP + SSE server entry point. Standalone Node process started
// by `pnpm serve`. Shares 100% of the agent core (turn.ts, retrieval,
// summarizer, tools) with the CLI (src/cli.ts). The CLI is the REPL;
// this file is the HTTP gateway to the same conversation logic.
//
// Scope for v0.8.1:
//   - 3 REST endpoints (list / create / get-by-id)
//   - 1 SSE endpoint stub (returns one `done` event; full turn loop is v0.8.3)
//   - Listen on env.PORT (default 3000)
//
// Future sprints add:
//   - v0.8.2 — static SPA serving (when web/dist exists)
//   - v0.8.3 — full SSE turn loop (text-chunk / phase / tool events)
//   - v0.8.4 — GET/PUT /api/settings (USER.md atomic write)

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import {
  createMarkMistakeTool,
  createMemorySearchTool,
  createSummarizeHistoryTool,
  createToolRegistry,
  createTopicSelectTool,
  loadLastReview,
} from './agent/index.js'
import { loadEnv } from './config/env.js'
import { createAnthropicProvider } from './llm/anthropic.js'
import { createReplayProvider, createThrowingProvider } from './llm/testing.js'
import type { LLMClient } from './llm/types.js'
import { createTransformersEmbedder } from './memory/index.js'
import { loadSystemPrompt } from './prompts/loader.js'
import {
  applyMigrations,
  createMessagesDao,
  createMistakesDao,
  createSessionsDao,
  createTopicStatsDao,
  createTopicsDao,
  openDb,
} from './storage/index.js'

// ---------- API JSON shape ----------
// Internal Session row uses snake_case columns. The API contract is
// camelCase (per v0.8-design.md §3.1). This helper is the single point
// of conversion so we don't leak the DB shape over the wire.
interface SessionApi {
  id: string
  startedAt: string
  endedAt: string | null
  durationMin: number | null
  phaseHistory: string[]
  summary: string | null
  keywords: string[]
  topicMatch: string | null
}

function toApiSession(row: {
  id: string
  started_at: string
  ended_at: string | null
  duration_min: number | null
  phase_history: string | null
  summary: string | null
  keywords: string | null
}): SessionApi {
  let phaseHistory: string[] = []
  if (row.phase_history) {
    try {
      phaseHistory = (JSON.parse(row.phase_history) as Array<{ phase: string }>).map((p) => p.phase)
    } catch {
      // Malformed JSON shouldn't break the API; return empty array.
    }
  }
  let keywords: string[] = []
  if (row.keywords) {
    try {
      keywords = JSON.parse(row.keywords) as string[]
    } catch {
      // Same defensive policy.
    }
  }
  return {
    id: row.id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationMin: row.duration_min,
    phaseHistory,
    summary: row.summary,
    keywords,
    topicMatch: null, // v0.8.1: not surfaced in list view (v0.8.4 history detail)
  }
}

// ---------- LLM client selection (mirrors src/cli.ts selectClient) ----------
function selectClient(env: ReturnType<typeof loadEnv>, fixturesDir: string): LLMClient {
  const testFail = process.env.LLM_TEST_FAIL
  if (testFail) {
    const status = Number.parseInt(testFail, 10)
    if (Number.isFinite(status)) {
      return createThrowingProvider(status, `LLM_TEST_FAIL=${status}`)
    }
  }
  if (process.env.RUN_LIVE_LLM === '1') {
    return createAnthropicProvider(env)
  }
  if (!existsSync(fixturesDir)) {
    throw new Error(
      `Replay mode (default) needs fixtures at ${fixturesDir}. Either create fixtures, or set RUN_LIVE_LLM=1 to use the live API.`,
    )
  }
  return createReplayProvider(fixturesDir)
}

// ---------- App factory ----------
// Exported as `createApp` so L1 tests can mount the app with a mock
// DbHandle (in-memory SQLite) and test handler logic without binding
// to a port. `startServer` (below) is the production entry.
export function createApp(opts: { dataDir: string; fixturesDir: string }): Hono {
  const env = loadEnv()
  const db = openDb({ dataDir: opts.dataDir })
  applyMigrations(db)
  const sessions = createSessionsDao(db)
  const messages = createMessagesDao(db)
  const topics = createTopicsDao(db)
  const topicStats = createTopicStatsDao(db)
  const mistakesDao = createMistakesDao(db)
  const systemPrompt = loadSystemPrompt()
  const client = selectClient(env, opts.fixturesDir)
  const embedder = createTransformersEmbedder()
  const lastReview = loadLastReview(db)

  // Register tools so the v0.8.3 turn loop can dispatch. v0.8.1 doesn't
  // call them yet (the SSE endpoint is a stub), but the registry is here
  // so the wiring is correct when we flip the switch.
  const toolRegistry = createToolRegistry()
  toolRegistry.register(createMarkMistakeTool(db, 'placeholder-id'))
  toolRegistry.register(createMemorySearchTool(db, embedder))
  toolRegistry.register(createSummarizeHistoryTool())
  toolRegistry.register(
    createTopicSelectTool({
      topics: topics.list(),
      stats: topicStats.all(),
      interests: [],
    }),
  )

  const app = new Hono()

  // ---- 1. GET /api/sessions ----
  // Per v0.8-design.md §3.1: returns list of sessions sorted by startedAt DESC.
  app.get('/api/sessions', (c) => {
    const rows = sessions.list()
    return c.json({
      sessions: rows.map((r) =>
        toApiSession({
          id: r.id,
          started_at: r.started_at,
          ended_at: r.ended_at,
          duration_min: r.duration_min,
          phase_history: r.phase_history,
          summary: r.summary,
          keywords: r.keywords,
        }),
      ),
    })
  })

  // ---- 2. POST /api/sessions ----
  // Creates a new session row. v0.8.1: no body parsing (interests ignored).
  // v0.8.3 may parse `interests` from body to thread into topic_select.
  app.post('/api/sessions', (c) => {
    const row = sessions.create()
    return c.json({ id: row.id }, 201)
  })

  // ---- 3. GET /api/sessions/:id ----
  // Returns full session details. v0.8.1: no messages[] (added v0.8.4).
  app.get('/api/sessions/:id', (c) => {
    const id = c.req.param('id')
    const row = sessions.get(id)
    if (!row) {
      return c.json({ error: 'session not found', id }, 404)
    }
    return c.json(
      toApiSession({
        id: row.id,
        started_at: row.started_at,
        ended_at: row.ended_at,
        duration_min: row.duration_min,
        phase_history: row.phase_history,
        summary: row.summary,
        keywords: row.keywords,
      }),
    )
  })

  // ---- 4. GET /api/sessions/:id/stream (v0.8.1 stub) ----
  // Per v0.8-scope §v0.8.1 item 5: establish connection, return SSE `done`.
  // The full turn loop (text-chunk / phase / tool events) is v0.8.3.
  // v0.8.3 will:
  //   1. Validate session exists (404 if not).
  //   2. Read `?action=turn&input=...` from query.
  //   3. Build a TurnDeps with the singletons above + the session's history.
  //   4. for-await over runTurn() events, writeSSE({ event, data }) for each.
  app.get('/api/sessions/:id/stream', (c) => {
    const id = c.req.param('id')
    if (!sessions.get(id)) {
      return c.json({ error: 'session not found', id }, 404)
    }
    return streamSSE(c, async (stream) => {
      // Stub: send one `done` event with endedReason='stub' so clients
      // can verify the SSE plumbing works end-to-end. v0.8.3 will replace
      // this with a real runTurn() subscription.
      await stream.writeSSE({
        event: 'done',
        data: JSON.stringify({
          sessionId: id,
          endedReason: 'stub',
          note: 'v0.8.1 SSE stub — full turn loop is v0.8.3',
        }),
      })
    })
  })

  // ---- Health check (extra; not in PRD) ----
  // Useful for `curl localhost:3000/api/health` to verify the server is up.
  // Returns the count of sessions as a quick smoke check.
  app.get('/api/health', (c) => {
    return c.json({ ok: true, sessions: sessions.list().length })
  })

  return app
}

// ---------- Entry point ----------
async function startServer(): Promise<void> {
  const env = loadEnv()
  const dataDir = resolve(env.APP_DATA_DIR)
  const fixturesDir = resolve('tests/fixtures/replay')
  const app = createApp({ dataDir, fixturesDir })
  const port = env.PORT

  serve({ fetch: app.fetch, port }, (info) => {
    // v0.8.1 — minimal startup log. v0.8.5 polish may add a banner.
    console.log(`[server] listening on http://localhost:${info.port}`)
    console.log(`[server] data dir: ${dataDir}`)
    console.log(`[server] LLM mode: ${process.env.RUN_LIVE_LLM === '1' ? 'live' : 'replay'}`)
  })
}

// Auto-run when this file is the entry point (e.g. `node --import tsx src/server.ts`).
// When imported (e.g. by L1 tests), only `createApp` is exported.
const isEntry = import.meta.url === pathToFileURL(process.argv[1] ?? '').href
if (isEntry) {
  startServer().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
