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

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
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
  initState,
  loadLastReview,
  matchTopic,
  realClock,
  runTurn,
  summarize,
} from './agent/index.js'
import type { PhaseTransition, SessionState } from './agent/index.js'
import type { TurnOutput } from './agent/turn.js'
import { loadEnv } from './config/env.js'
import { createAnthropicProvider } from './llm/anthropic.js'
import { createReplayProvider, createThrowingProvider } from './llm/testing.js'
import type { LLMClient, Message } from './llm/types.js'
import { createTransformersEmbedder } from './memory/index.js'
import { loadSystemPrompt, loadUserFile, updateUserSettings } from './prompts/loader.js'
import { logSummarize } from './llm/debug-log.js'
import { extractStudentDiscoveries } from './agent/profile-extractor.js'
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

// ---------- Session runtime store (v0.8.3 in-memory) ----------
// SessionState is not persisted to SQLite. Between turns within a session,
// the server tracks the evolving state in this Map. On server restart,
// in-progress sessions lose state — acceptable for a single-user localhost
// tool with sessions typically lasting ≤30 min.

interface SessionRuntime {
  state: SessionState
  phaseHistory: PhaseTransition[]
  firstPair: Message[]
  isFirstTurn: boolean
  markedOriginals: Set<string>
}

function reconstructSessionState(
  session: { id: string; started_at: string; phase_history: string | null },
  store: Map<string, SessionRuntime>,
): SessionRuntime {
  const cached = store.get(session.id)
  if (cached) return cached

  const startedAt = new Date(session.started_at).getTime()
  const now = realClock.now()
  const elapsedMin = Math.max(0, (now - startedAt) / 60000)

  let phase: SessionState['phase'] = 'WARM_UP'
  const phaseHistory: PhaseTransition[] = []
  if (session.phase_history) {
    try {
      const parsed = JSON.parse(session.phase_history) as PhaseTransition[]
      if (parsed.length > 0) {
        phase = parsed[parsed.length - 1]?.phase ?? 'WARM_UP'
        phaseHistory.push(...parsed)
      }
    } catch {
      // Malformed JSON stays at WARM_UP
    }
  }
  if (phaseHistory.length === 0) {
    phaseHistory.push({ phase: 'WARM_UP', at: 0, reason: 'time' })
  }

  const state: SessionState = {
    phase,
    startedAt,
    lastUserMsgAt: now,
    elapsedMin,
    silenceMin: 0,
    lastTransitionAt: 0,
  }

  return {
    state,
    phaseHistory,
    firstPair: [],
    isFirstTurn: phaseHistory.length <= 1,
    markedOriginals: new Set(),
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
  // RUN_LIVE_LLM=1 takes priority — user explicitly wants the live API.
  if (process.env.RUN_LIVE_LLM?.trim() === '1') {
    return createAnthropicProvider(env)
  }
  // Default: replay mode. Requires fixtures to exist.
  if (!existsSync(fixturesDir)) {
    throw new Error(
      `Replay mode (default) needs fixtures at ${fixturesDir}. Either create fixtures, or set RUN_LIVE_LLM=1 to use the live API.`,
    )
  }
  return createReplayProvider(fixturesDir)
}

function regenerateTopicLibrary(topicList: Array<{ name: string; keywords: string[]; description: string | null }>): void {
  const lines: string[] = [
    '# Topic Library — 英语口语话题库',
    '',
    'MAIN_ACTIVITY 阶段参考此文件选题。按学生级别分类。',
    '',
    '---',
    '',
    '### 选题策略',
    '',
    '1. **检查 Active topics** — 优先选讨论次数最少的，次数相同时选最近没聊过的。这是硬性约束。',
    '2. **首选题匹配学生水平的话题**',
    '3. **已聊过的话题可以深入** — 追问新角度、新进展、新观点',
    '4. **话题枯竭立即换题** — 学生 3 次短回答 = 信号',
    '5. **一次只引入一个话题** — 不要跳跃',
    '6. **结合学生兴趣** — 参考 USER.md 中的 interests 字段',
    '',
    '---',
    '',
    '## 话题列表',
    '',
  ]
  for (const t of topicList) {
    lines.push(`### ${t.description}`)
    lines.push('')
    if (t.keywords.length > 0) {
      lines.push(`关键词: ${t.keywords.slice(0, 12).join(', ')}${t.keywords.length > 12 ? '...' : ''}`)
      lines.push('')
      lines.push('讨论角度:')
      for (const kw of t.keywords.slice(0, 8)) {
        lines.push(`- ${kw}`)
      }
      lines.push('')
    }
    lines.push('---')
    lines.push('')
  }
  const path = resolve('prompts/topic-library.md')
  writeFileSync(path, lines.join('\n'), 'utf-8')
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
  // v1.0.1 — UI preferences stored in a JSON file (localStorage is not
  // reliable across browser restarts). Voice settings stay in USER.md.
  const prefsPath = resolve(opts.dataDir, 'preferences.json')
  function loadPrefs(): Record<string, unknown> {
    try {
      if (existsSync(prefsPath)) {
        return JSON.parse(readFileSync(prefsPath, 'utf-8'))
      }
    } catch { /* ignore */ }
    return {}
  }
  function savePrefs(updates: Record<string, unknown>): void {
    const current = loadPrefs()
    const merged = { ...current, ...updates }
    writeFileSync(prefsPath, JSON.stringify(merged), 'utf-8')
  }

  const sessionStore = new Map<string, SessionRuntime>()

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
  // v0.8.4: returns full session details + messages[].
  app.get('/api/sessions/:id', (c) => {
    const id = c.req.param('id')
    const row = sessions.get(id)
    if (!row) {
      return c.json({ error: 'session not found', id }, 404)
    }
    const msgs = messages.getBySession(id)
    return c.json({
      ...toApiSession({
        id: row.id,
        started_at: row.started_at,
        ended_at: row.ended_at,
        duration_min: row.duration_min,
        phase_history: row.phase_history,
        summary: row.summary,
        keywords: row.keywords,
      }),
      messages: msgs.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        ts: m.ts,
      })),
    })
  })

  // ---- 4. GET /api/sessions/:id/stream (v0.8.3 real turn loop) ----
  // Query params:
  //   ?action=init — return current phase + done (for initial page load)
  //   ?action=turn&input=... — run one turn, stream all TurnEvents as SSE
  app.get('/api/sessions/:id/stream', async (c) => {
    const id = c.req.param('id')
    const action = c.req.query('action')
    const input = c.req.query('input')

    const row = sessions.get(id)
    if (!row) return c.json({ error: 'session not found', id }, 404)

    // -- action=init: return current phase --
    if (action === 'init') {
      return streamSSE(c, async (stream) => {
        const rt = reconstructSessionState(
          { id: row.id, started_at: row.started_at, phase_history: row.phase_history },
          sessionStore,
        )
        await stream.writeSSE({
          event: 'phase',
          data: JSON.stringify({ phase: rt.state.phase, elapsed: rt.state.elapsedMin }),
        })
        await stream.writeSSE({
          event: 'done',
          data: JSON.stringify({ endedReason: 'init' }),
        })
      })
    }

    // -- action=turn: run one turn --
    if (action === 'turn') {
      if (!input || input.trim() === '') {
        return c.json({ error: 'input required for action=turn' }, 400)
      }

      const rt = reconstructSessionState(
        { id: row.id, started_at: row.started_at, phase_history: row.phase_history },
        sessionStore,
      )

      if (rt.state.phase === 'END') {
        return streamSSE(c, async (stream) => {
          await stream.writeSSE({
            event: 'error',
            data: JSON.stringify({
              classification: 'session_ended',
              message: 'Session already ended',
            }),
          })
          await stream.writeSSE({
            event: 'done',
            data: JSON.stringify({ endedReason: 'session_ended' }),
          })
        })
      }

      const dbMessages = messages.getBySession(id)
      const history: Message[] = dbMessages.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }))

      // Load last review dynamically — new summaries may have been added
      // since the server started. Not cached at module level.
      const lastReview = rt.isFirstTurn ? loadLastReview(db) : null

      const turnInput = {
        sessionId: id,
        userInput: input.trim(),
        state: rt.state,
        history,
        phaseHistory: rt.phaseHistory,
        firstPair: rt.firstPair,
        relevantPast: [],
        activeTopics: topicStats.all(),
        recentMistakes: mistakesDao.getRecent(5),
        lastReview,
        isFirstTurn: rt.isFirstTurn,
        systemPrompt,
        mockTime: false,
      }

      const turnDeps = {
        env: { LLM_CONTEXT_BUDGET_TOKENS: env.LLM_CONTEXT_BUDGET_TOKENS },
        clock: realClock,
        client,
        embedder,
        toolRegistry,
        sessions,
        messages,
        topicStats,
        markedOriginals: rt.markedOriginals,
      }

      return streamSSE(c, async (stream) => {
        const gen = runTurn(turnInput, turnDeps)
        while (true) {
          const next = await gen.next()
          if (next.done) {
            const output = next.value as TurnOutput
            sessionStore.set(id, {
              state: output.state,
              phaseHistory: output.phaseHistory,
              firstPair: output.firstPair,
              isFirstTurn: output.isFirstTurn,
              markedOriginals: rt.markedOriginals,
            })
            await stream.writeSSE({
              event: 'done',
              data: JSON.stringify({ endedReason: output.endedReason }),
            })

            // v0.8.5 — when a session ends, summarize and mark it as complete.
            // This mirrors the CLI's finally block (src/cli.ts). Without this,
            // lastReview / relevantPast are never populated for web sessions.
            if (output.endedReason) {
              const allMsgs = messages.getBySession(id)
              const msgObjs = allMsgs.map((m) => ({
                role: m.role as 'user' | 'assistant',
                content: m.content,
              }))
              try {
                const review = await summarize(msgObjs, client)
                logSummarize(id, msgObjs.length, review)

                // Auto-extract student profile updates from the summary
                try {
                  const discoveries = await extractStudentDiscoveries(
                    review.summary,
                    systemPrompt.userProfile.interests,
                    client,
                  )
                  if (discoveries.newInterests.length > 0 || discoveries.bodyUpdate) {
                    await updateUserSettings({
                      interests: discoveries.newInterests,
                      bodyAppend: discoveries.bodyUpdate ?? undefined,
                    })
                  }
                } catch {
                  // Best-effort — don't block session end on profile extraction
                }

                sessions.markEnded(id, {
                  phaseHistory: output.phaseHistory,
                  summary: review.summary,
                  keywords: review.keywords,
                  reason: output.endedReason,
                })
                // Update topic stats from summary keywords
                try {
                  const matched = matchTopic(review.keywords, topics.list())
                  if (matched) {
                    topicStats.incrementAndUpdate(matched.topic, new Date())
                  }
                } catch {
                  // topic matching is best-effort
                }
                // Generate embedding for cross-session retrieval
                try {
                  const vec = await embedder.embed(review.summary)
                  sessions.setEmbedding(id, vec)
                } catch {
                  // embedding is best-effort
                }
              } catch {
                // If summarization fails, still mark as ended with a placeholder
                sessions.markEnded(id, {
                  phaseHistory: output.phaseHistory,
                  summary: '(summarization failed)',
                  keywords: [],
                  reason: output.endedReason,
                })
              }
            }

            break
          }
          await stream.writeSSE({
            event: next.value.type,
            data: JSON.stringify(next.value),
          })
        }
      })
    }

    return c.json({ error: 'invalid action. Use action=init or action=turn' }, 400)
  })

  // ---- 5. GET /api/settings ----
  // v0.8.4 — returns current settings from USER.md frontmatter + prefs file + defaults.
  app.get('/api/settings', (c) => {
    const { data } = loadUserFile()
    const prefs = loadPrefs()
    return c.json({
      voice_enabled: data.voice_enabled ?? false,
      voice_speed: data.voice_speed ?? 1.0,
      voice_accent: data.voice_accent ?? 'en-US',
      font_size: prefs.font_size ?? 14,
      show_debug: prefs.show_debug ?? false,
      mic_hotkey: prefs.mic_hotkey ?? null,
      send_hotkey: prefs.send_hotkey ?? null,
    })
  })

  // ---- 7. DELETE /api/sessions/:id ----
  app.delete('/api/sessions/:id', (c) => {
    const id = c.req.param('id')
    const row = sessions.get(id)
    if (!row) return c.json({ error: 'session not found', id }, 404)
    sessions.delete(id)
    sessionStore.delete(id)
    return c.json({ ok: true })
  })

  // ---- 8. GET /api/topics ----
  app.get('/api/topics', (c) => {
    const all = topics.list()
    return c.json(
      all.map((t) => ({
        name: t.name,
        keywords: t.keywords,
        description: t.description,
      })),
    )
  })

  // ---- 9. PUT /api/topics ----
  app.put('/api/topics', async (c) => {
    const body = (await c.req.json()) as Array<{ name: string; keywords: string[]; description: string }>
    if (!Array.isArray(body)) return c.json({ error: 'expected array of topics' }, 400)

    // Replace all topics in a transaction
    const updateTopic = db.raw.prepare(
      'INSERT INTO topics (name, keywords_json, description, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET keywords_json = excluded.keywords_json, description = excluded.description',
    )
    const now = new Date().toISOString()
    for (const t of body) {
      updateTopic.run(t.name, JSON.stringify(t.keywords), t.description, now)
    }
    // Remove topics not in the update list
    const names = body.map((t) => t.name)
    const placeholders = names.map(() => '?').join(',')
    db.raw.prepare(`DELETE FROM topics WHERE name NOT IN (${placeholders})`).run(...names)

    // Also regenerate prompts/topic-library.md
    regenerateTopicLibrary(topics.list())

    return c.json({ ok: true })
  })

  // ---- 6. PUT /api/settings ----
  // v0.8.4 — persists voice_* fields to USER.md via atomic write.
  app.put('/api/settings', async (c) => {
    const body = await c.req.json()
    const persisted: string[] = []
    const updates: Record<string, unknown> = {}

    if (typeof body.voice_enabled === 'boolean') {
      updates.voice_enabled = body.voice_enabled
      persisted.push('voice_enabled')
    }
    if (typeof body.voice_speed === 'number') {
      updates.voice_speed = body.voice_speed
      persisted.push('voice_speed')
    }
    if (typeof body.voice_accent === 'string') {
      updates.voice_accent = body.voice_accent
      persisted.push('voice_accent')
    }

    if (persisted.length > 0) {
      await updateUserSettings(
        updates as { voice_enabled?: boolean; voice_speed?: number; voice_accent?: string },
      )
    }

    // v1.0.1 — persist UI preferences to prefs file (localStorage unreliable)
    const prefsUpdates: Record<string, unknown> = {}
    if (typeof body.font_size === 'number') {
      prefsUpdates.font_size = body.font_size
      persisted.push('font_size')
    }
    if (typeof body.show_debug === 'boolean') {
      prefsUpdates.show_debug = body.show_debug
      persisted.push('show_debug')
    }
    if (body.mic_hotkey && typeof body.mic_hotkey === 'object') {
      prefsUpdates.mic_hotkey = body.mic_hotkey
      persisted.push('mic_hotkey')
    }
    if (body.send_hotkey && typeof body.send_hotkey === 'object') {
      prefsUpdates.send_hotkey = body.send_hotkey
      persisted.push('send_hotkey')
    }
    if (Object.keys(prefsUpdates).length > 0) {
      savePrefs(prefsUpdates)
    }

    return c.json({ ok: true, persisted })
  })

  // ---- Health check (extra; not in PRD) ----
  // Useful for `curl localhost:3000/api/health` to verify the server is up.
  // Returns the count of sessions as a quick smoke check.
  app.get('/api/health', (c) => {
    return c.json({ ok: true, sessions: sessions.list().length })
  })

  // ---- Production SPA fallback (v0.8.5) ----
  // When web/dist exists (pnpm build has been run), serve the built SPA for
  // any non-API route. Vite outputs index.html + assets/ under web/dist/.
  const distIndex = resolve('web/dist/index.html')
  if (existsSync(distIndex)) {
    const distDir = resolve('web/dist')
    app.get('/assets/*', (c) => {
      const filePath = resolve(distDir, c.req.path.slice(1))
      if (!existsSync(filePath) || !filePath.startsWith(distDir)) return c.notFound()
      const ext = filePath.split('.').pop()
      const mime: Record<string, string> = {
        js: 'text/javascript',
        css: 'text/css',
        svg: 'image/svg+xml',
        png: 'image/png',
        ico: 'image/x-icon',
        woff2: 'font/woff2',
      }
      return c.body(readFileSync(filePath), 200, {
        'Content-Type': mime[ext ?? ''] ?? 'application/octet-stream',
      })
    })
    app.get('/*', (c) => {
      if (c.req.path.startsWith('/api')) return c.notFound()
      return c.html(readFileSync(distIndex, 'utf-8'))
    })
  }

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
    console.log(
      `[server] LLM mode: ${process.env.RUN_LIVE_LLM?.trim() === '1' ? 'live' : 'replay'}`,
    )
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
