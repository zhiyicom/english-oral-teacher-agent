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
import { exec } from 'node:child_process'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
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
import { extractStudentDiscoveries } from './agent/profile-extractor.js'
import type { TurnOutput } from './agent/turn.js'
import { loadEnv } from './config/env.js'
import { getAppDataDir, getReplayFixturesDir } from './config/paths.js'
import { getApiKey, getEnvVar, isSetupNeeded, setApiKey as setApiKeyPersist, setEnvVar } from './config/secrets.js'
import { createAnthropicProvider } from './llm/anthropic.js'
import { logSummarize, logSummarizeFailure, logWebDiagnostic } from './llm/debug-log.js'
import { createReplayProvider, createThrowingProvider } from './llm/testing.js'
import type { LLMClient, Message } from './llm/types.js'
import { checkForUpdate } from './update-checker.js'
import { createTransformersEmbedder } from './memory/index.js'
import { loadSystemPrompt, loadUserFile, updateUserSettings } from './prompts/loader.js'
import {
  applyMigrations,
  createKeywordHitsDao,
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
export function createApp(opts: {
  dataDir: string
  fixturesDir: string
  webDistDir?: string
}): Hono {
  const env = loadEnv()
  const db = openDb({ dataDir: opts.dataDir })
  applyMigrations(db)
  const sessions = createSessionsDao(db)
  const messages = createMessagesDao(db)
  const topics = createTopicsDao(db)
  const topicStats = createTopicStatsDao(db)
  const keywordHits = createKeywordHitsDao(db)
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

  // v1.0.3 §1.3 — WARM_UP opener hook seeded by last session's profile-extract.
  // Module-scoped memory: server restart loses it (acceptable, falls back to
  // the existing "natural connection" WARM_UP hint when null). Single-user
  // system, so a global is sufficient — no per-user keying needed.
  let pendingWarmUpSeed: string | null = null

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
      // v1.0.2 — keyword-freshness bias. Read once at startup; only
      // mutated in the session-end finally block (same module-scoped DB),
      // so reading once is correct (mirrors how `stats` is loaded above).
      keywordStats: keywordHits.getAll(),
      // v1.0.3 §1.3 — D3 (interest boost) disabled. WARM_UP phase prompt
      // handles interest matching; this tool only sees call-count signals.
      useInterestBoost: false,
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
  // v1.0.3 §1.3 — also returns `warmUpHook` (and clears the module-scoped
  // pending seed). Read-once semantics: subsequent POST calls without a
  // prior session-end will return `null`. Web stores this in React state
  // and passes it back via /stream body for the first-turn WARM_UP hint.
  app.post('/api/sessions', (c) => {
    const row = sessions.create()
    const warmUpHook = pendingWarmUpSeed
    pendingWarmUpSeed = null
    return c.json({ id: row.id, warmUpHook }, 201)
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
  //   v1.0.3 §1.3 — ?warmUpHook=... — WARM_UP opener keyword from the
  //     session-end profile-extract of the previous session. Web passes
  //     this on first-turn only; null when not provided.
  app.get('/api/sessions/:id/stream', async (c) => {
    const id = c.req.param('id')
    const action = c.req.query('action')
    const input = c.req.query('input')
    const warmUpHookRaw = c.req.query('warmUpHook')
    const warmUpHook =
      typeof warmUpHookRaw === 'string' && warmUpHookRaw.trim().length > 0
        ? warmUpHookRaw.trim()
        : null

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
        // v1.0.3 §1.3 — LLM-picked WARM_UP opener from previous session's
        // profile-extract. Only meaningful on the first turn; later turns
        // ignore it because the WARM_UP hint block is gated by wasFirstTurn.
        warmUpHook,
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
                  // v1.0.3 §1.3 — cache next session's WARM_UP opener hook.
                  // In-memory only; consumed by next POST /api/sessions call.
                  pendingWarmUpSeed = discoveries.nextWarmUpSeed
                } catch {
                  // Best-effort — don't block session end on profile extraction
                }

                sessions.markEnded(id, {
                  phaseHistory: output.phaseHistory,
                  summary: review.summary,
                  keywords: review.keywords,
                  reason: output.endedReason,
                })
                // Update topic stats + per-keyword hits from summary keywords
                try {
                  const matched = matchTopic(review.keywords, topics.list())
                  if (matched) {
                    const now = new Date()
                    topicStats.incrementAndUpdate(matched.topic, now)
                    // v1.0.2 — accumulate per-(topic, keyword) hits so the
                    // keyword-freshness bias in selectTopic() can prefer
                    // topics whose inner keywords are still under-used.
                    keywordHits.upsertMany(matched.topic, matched.shared, now)
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
              } catch (err) {
                // v0.8.5 — mirror CLI: log the failure to stderr so the cause
                // is diagnosable. The placeholder keeps markEnded running so
                // the session isn't lost, but the silent catch from v0.8.4
                // (and earlier) made every "summarization failed" row a
                // mystery. Format mirrors src/cli.ts:483.
                process.stderr.write(
                  `[server] summarize failed session=${id.slice(0, 8)} msgs=${msgObjs.length} err=${(err as Error).message}\n`,
                )
                // v1.0.6 hotfix — also write a structured failure record to
                // data/llm-debug/ so the next silent failure is diagnosable
                // without needing the stderr stream (web mode has no terminal).
                logSummarizeFailure(id, msgObjs.length, output.endedReason, err)
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
      run_live_llm: getEnvVar('RUN_LIVE_LLM') === '1',
    })
  })

  // ---- 7. DELETE /api/sessions/:id ----
  app.delete('/api/sessions/:id', (c) => {
    const id = c.req.param('id')
    const row = sessions.get(id)
    if (!row) return c.json({ error: 'session not found', id }, 404)
    // v1.0.3 §1.3 — if this deleted session was the latest with a summary,
    // its WARM_UP opener seed (cached in `pendingWarmUpSeed`) is now orphaned
    // and must NOT surface in the next session's first-turn hint. Deleting
    // an older session leaves the seed alone (it was produced by the newer
    // session-end, not this one). Use loadLastReview() before the DELETE so
    // the row is still visible.
    if (
      pendingWarmUpSeed !== null &&
      row.summary &&
      row.summary.length > 30 &&
      loadLastReview(db)?.sessionId === id
    ) {
      pendingWarmUpSeed = null
    }
    sessions.delete(id)
    sessionStore.delete(id)
    return c.json({ ok: true })
  })

  // ---- 8. GET /api/topics ----
  // v1.0.2 — joins topic_stats + keyword_hits so the Web UI can render
  // hit counts without a second round-trip.
  // - `hitCount` is the per-topic discussion_count (0 included for topics
  //   that have never been selected).
  // - `keywordHits` is `Record<keyword, hit_count>` for keywords that have
  //   at least one hit. Keywords with 0 hits are omitted (they wouldn't
  //   appear in the table) — the UI shows them as 0 directly.
  app.get('/api/topics', (c) => {
    const all = topics.list()
    const allStats = topicStats.all()
    const allKeywordHits = keywordHits.getAll()
    const statByTopic = new Map(allStats.map((s) => [s.topic, s.discussionCount]))
    const hitsByTopic = new Map<string, Record<string, number>>()
    for (const h of allKeywordHits) {
      const bucket = hitsByTopic.get(h.topic) ?? {}
      bucket[h.keyword] = h.hitCount
      hitsByTopic.set(h.topic, bucket)
    }
    return c.json(
      all.map((t) => ({
        name: t.name,
        keywords: t.keywords,
        description: t.description,
        hitCount: statByTopic.get(t.name) ?? 0,
        keywordHits: hitsByTopic.get(t.name) ?? {},
      })),
    )
  })

  // ---- 9. PUT /api/topics ----
  // v1.0.2 — field whitelist. The body is parsed but ONLY `name`,
  // `keywords`, `description` are persisted. Any `hitCount` / `keywordHits`
  // that a client accidentally sends are silently dropped to keep the
  // aggregated stats tables from being clobbered.
  app.put('/api/topics', async (c) => {
    const rawBody = (await c.req.json()) as unknown
    if (!Array.isArray(rawBody)) return c.json({ error: 'expected array of topics' }, 400)
    const body = rawBody.map((row) => {
      const r = row as { name?: unknown; keywords?: unknown; description?: unknown }
      return {
        name: typeof r.name === 'string' ? r.name : '',
        keywords: Array.isArray(r.keywords) ? (r.keywords as string[]) : [],
        description: typeof r.description === 'string' ? r.description : '',
      }
    })

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
    // v1.0.6 — RUN_LIVE_LLM persisted to AppData/.env
    if (typeof body.run_live_llm === 'boolean') {
      try {
        setEnvVar('RUN_LIVE_LLM', body.run_live_llm ? '1' : '0')
        persisted.push('run_live_llm')
      } catch { /* best-effort */ }
    }

    if (Object.keys(prefsUpdates).length > 0) {
      savePrefs(prefsUpdates)
    }

    return c.json({ ok: true, persisted })
  })

  // ---- /setup endpoints (v1.0.6 §1.6) ----

  app.get('/api/setup/status', (c) => {
    const needsApiKey = isSetupNeeded()
    let hasUserProfile = false
    try {
      const { data } = loadUserFile()
      hasUserProfile = Boolean(
        typeof data.name === 'string' && data.name.length > 0 &&
        typeof data.age === 'number'
      )
    } catch { /* missing = false */ }
    const runLiveLlm = getEnvVar('RUN_LIVE_LLM') === '1'
    return c.json({
      needsApiKey,
      hasUserProfile,
      runLiveLlm,
      appDataDir: getAppDataDir(),
      version: process.env.npm_package_version ?? '0.0.0',
    })
  })

  app.get('/api/setup/profile-default', (c) => {
    const { data } = loadUserFile()
    return c.json({
      name: data.name ?? '',
      age: data.age ?? 13,
      level: data.level ?? 'intermediate',
      goals: data.goals ?? [],
      interests: data.interests ?? [],
    })
  })

  app.post('/api/setup/api-key', async (c) => {
    const body = await c.req.json()
    const key = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
    if (!key) return c.json({ error: 'apiKey required' }, 400)
    try {
      const persisted: string[] = []
      persisted.push(...setApiKeyPersist(key).persisted)
      // v1.0.6 — also save RUN_LIVE_LLM from setup wizard step 1
      if (typeof body.runLiveLlm === 'boolean') {
        persisted.push(...setEnvVar('RUN_LIVE_LLM', body.runLiveLlm ? '1' : '0').persisted)
      }
      return c.json({ ok: true, persisted })
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500)
    }
  })

  app.post('/api/setup/profile', async (c) => {
    const body = await c.req.json()
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    const age = Number(body.age)
    const level = body.level
    if (!name) return c.json({ error: 'name required' }, 400)
    if (!Number.isFinite(age) || age < 3 || age > 120) {
      return c.json({ error: 'age must be 3..120' }, 400)
    }
    if (level !== 'beginner' && level !== 'intermediate' && level !== 'advanced') {
      return c.json({ error: 'level must be beginner|intermediate|advanced' }, 400)
    }
    await updateUserSettings({
      name,
      age,
      level,
      goals: Array.isArray(body.goals) ? body.goals.map(String) : [],
      interests: Array.isArray(body.interests) ? body.interests.map(String) : [],
    })
    return c.json({ ok: true })
  })

  // ---- /api/update/check (v1.0.6 §1.4) ----
  app.get('/api/update/check', async (c) => {
    const version = process.env.npm_package_version ?? '0.0.0'
    const info = await checkForUpdate(version)
    return c.json(info)
  })

  // ---- Health check (extra; not in PRD) ----
  // Useful for `curl localhost:3000/api/health` to verify the server is up.
  // Returns the count of sessions as a quick smoke check.
  app.get('/api/health', (c) => {
    return c.json({ ok: true, sessions: sessions.list().length })
  })

  // ---- Diagnostic log endpoint (v1.0.1) ----
  // Client posts one event per turn when localStorage `debug:web_diag=1`
  // is set. Server appends to the same diag-*.jsonl file used by
  // turn.ts so server-side and client-side events can be correlated.
  app.post('/api/diagnostic/log', async (c) => {
    if (process.env.DEBUG_LOG_LLM !== '1') return c.json({ ok: false, reason: 'disabled' }, 403)
    let body: { sessionId?: string; type?: string; data?: Record<string, unknown> } = {}
    try {
      body = await c.req.json()
    } catch {
      return c.json({ ok: false, reason: 'invalid json' }, 400)
    }
    if (!body.sessionId || typeof body.sessionId !== 'string') {
      return c.json({ ok: false, reason: 'sessionId required' }, 400)
    }
    logWebDiagnostic(body.sessionId, { type: body.type ?? 'unknown', ...(body.data ?? {}) })
    return c.json({ ok: true })
  })

  // ---- SPA fallback (v1.0.5.1 §1.1) ----
  // Always-on (no existsSync gate). After `pnpm build`, the postbuild step
  // copies web/dist/* to dist/web/ so distDir = __dirname/web resolves
  // correctly. Dev mode uses `pnpm dev-web` (Vite on 5173) and does not
  // hit this code path. `opts.webDistDir` lets tests inject a fixture.
  const distDir = opts.webDistDir ?? resolve(dirname(fileURLToPath(import.meta.url)), 'web')
  const distIndex = join(distDir, 'index.html')
  app.get('/assets/*', (c) => {
    const filePath = resolve(distDir, c.req.path.slice(1))
    if (!filePath.startsWith(distDir)) return c.notFound()
    if (!existsSync(filePath)) return c.notFound()
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
    if (!existsSync(distIndex)) return c.text('SPA not built. Run `pnpm build` first.', 500)
    return c.html(readFileSync(distIndex, 'utf-8'))
  })

  return app
}

// ---------- Entry point ----------
async function startServer(): Promise<void> {
  const env = loadEnv()
  const dataDir = getAppDataDir()
  const fixturesDir = getReplayFixturesDir()
  const app = createApp({ dataDir, fixturesDir })
  const port = env.PORT

  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`[server] listening on http://localhost:${info.port}`)
    console.log(`[server] data dir: ${dataDir}`)
    console.log(
      `[server] LLM mode: ${process.env.RUN_LIVE_LLM?.trim() === '1' ? 'live' : 'replay'}`,
    )

    // v1.0.6 §1.3 — auto-open browser when installer sets the env var.
    // Skipped in dev / CI / tests.
    if (process.env.ENGLISH_ORAL_TEACHER_AUTO_OPEN === '1') {
      try {
        const url = `http://localhost:${info.port}`
        if (process.platform === 'win32') {
          exec(`start "" "${url}"`)
        } else if (process.platform === 'darwin') {
          exec(`open "${url}"`)
        } else {
          exec(`xdg-open "${url}"`)
        }
      } catch (err) {
        console.warn(`[server] failed to auto-open browser: ${(err as Error).message}`)
      }
    }
  }).on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `\n[server] FATAL: port ${port} is already in use.\n` +
        `  To use a different port:\n` +
        `    1. Edit ${join(getAppDataDir(), '.env')} and set PORT=<other>\n` +
        `    2. Restart English Oral Teacher\n` +
        `  Or close the application that is using port ${port}.\n`,
      )
      process.exit(1)
    }
    throw err
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
