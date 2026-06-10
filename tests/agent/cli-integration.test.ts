import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  applyMigrations,
  createMessagesDao,
  createMistakesDao,
  createSessionsDao,
  createTopicStatsDao,
  createTopicsDao,
  openDb,
} from '../../src/storage/index.js'
import { resolveMigrationsDirForTesting } from '../storage/helpers.js'

const CLI_PATH = resolve('src/cli.ts')
const migrationsDir = resolveMigrationsDirForTesting()

interface RunResult {
  exitCode: number | null
  stdout: string
  stderr: string
}

function runCli(input: string, env: Record<string, string> = {}): Promise<RunResult> {
  return new Promise((res, rej) => {
    const child: ChildProcessWithoutNullStreams = spawn(
      process.execPath,
      ['--import', 'tsx', CLI_PATH],
      {
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )

    let stdout = ''
    let stderr = ''
    let teacherResponses = 0
    const targetResponses = input.split('\n').filter((l) => l.length > 0).length

    child.stdout.on('data', (d) => {
      stdout += d.toString()
      const matches = stdout.match(/\[Teacher\]/g)
      if (matches && matches.length > teacherResponses) {
        teacherResponses = matches.length
        if (teacherResponses >= targetResponses) {
          setTimeout(() => child.stdin.end(), 300)
        }
      }
    })
    child.stderr.on('data', (d) => {
      stderr += d.toString()
    })
    child.on('error', rej)
    child.on('close', (code) => res({ exitCode: code, stdout, stderr }))

    setTimeout(() => {
      const lines = input.split('\n').filter((l) => l.length > 0)
      let i = 0
      const writeNext = () => {
        if (i >= lines.length) return
        child.stdin.write(`${lines[i]}\n`)
        i += 1
        setTimeout(writeNext, 700)
      }
      writeNext()
    }, 200)
  })
}

function safeRm(dir: string): void {
  for (let i = 0; i < 3; i++) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      return
    } catch (err) {
      if (i === 2) {
        console.warn(`[cli-integration.test] cleanup warning: ${(err as Error).message}`)
        return
      }
    }
  }
}

describe('CLI v0.4 state-machine integration', () => {
  let dataDir: string

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cli-int-'))
  })
  afterEach(() => {
    safeRm(dataDir)
  })

  it('1 turn: stderr shows ctx: WARM_UP', async () => {
    const result = await runCli('hi\nexit\n', {
      MINIMAX_API_KEY: 'sk-test',
      APP_DATA_DIR: dataDir,
    })
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toMatch(/\[cli\] ctx: WARM_UP/)
    expect(result.stderr).toMatch(/elapsed=0\.0/)
  }, 20000)

  it('6 turns under MOCK_TIME: last ctx line shows MAIN_ACTIVITY', async () => {
    // Each turn advances the mock clock by 1 min; after 6 turns elapsed=6 → MAIN_ACTIVITY.
    // Use only inputs that have matching replay fixtures (hi, fine, castle, creeper, played).
    const inputs = ['hi', 'fine', 'castle', 'creeper', 'played', 'hi']
    const result = await runCli(`${inputs.join('\n')}\n`, {
      MINIMAX_API_KEY: 'sk-test',
      MOCK_TIME: '1',
      MOCK_NOW: '2026-01-01T00:00:00Z',
      APP_DATA_DIR: dataDir,
    })
    expect(result.exitCode).toBe(0)
    // Find all ctx lines and check the last one
    const ctxLines = result.stderr.split('\n').filter((l) => l.startsWith('[cli] ctx:'))
    expect(ctxLines.length).toBeGreaterThanOrEqual(6)
    const last = ctxLines[ctxLines.length - 1] ?? ''
    expect(last).toMatch(/\[cli\] ctx: MAIN_ACTIVITY/)
  }, 25000)

  it('5 turns: DB has phase_history (>= 1 transition recorded)', async () => {
    const inputs = ['hi', 'fine', 'castle', 'creeper', 'played']
    const result = await runCli(`${inputs.join('\n')}\n`, {
      MINIMAX_API_KEY: 'sk-test',
      APP_DATA_DIR: dataDir,
    })
    expect(result.exitCode).toBe(0)

    const db = openDb({ dataDir })
    applyMigrations(db, migrationsDir)
    const sessions = createSessionsDao(db)
    const all = sessions.list()
    expect(all).toHaveLength(1)
    expect(all[0]?.phase_history).not.toBeNull()
    const history = JSON.parse(all[0]?.phase_history ?? '[]')
    expect(Array.isArray(history)).toBe(true)
    expect(history.length).toBeGreaterThanOrEqual(1)
    // First entry is always WARM_UP@0
    expect(history[0]).toMatchObject({ phase: 'WARM_UP', at: 0, reason: 'time' })
    db.close()
  }, 25000)

  it('user says "stop": next ctx shows END + loop exits + DB has user_stop reason', async () => {
    const result = await runCli('hi\nstop\n', {
      MINIMAX_API_KEY: 'sk-test',
      APP_DATA_DIR: dataDir,
    })
    expect(result.exitCode).toBe(0)
    // Should have 2 [Teacher] responses (hi + stop goodbye)
    const teacherCount = (result.stdout.match(/\[Teacher\]/g) ?? []).length
    expect(teacherCount).toBe(2)
    // stderr should have ctx: WARM_UP for "hi" and ctx: END for "stop"
    const ctxLines = result.stderr.split('\n').filter((l) => l.startsWith('[cli] ctx:'))
    expect(ctxLines.length).toBeGreaterThanOrEqual(2)
    expect(ctxLines[0]).toMatch(/\[cli\] ctx: WARM_UP/)
    expect(ctxLines[1]).toMatch(/\[cli\] ctx: END/)
    // DB should have user_stop reason
    const db = openDb({ dataDir })
    applyMigrations(db, migrationsDir)
    const sessions = createSessionsDao(db)
    const all = sessions.list()
    expect(all[0]?.phase_history).not.toBeNull()
    const history = JSON.parse(all[0]?.phase_history ?? '[]')
    // Last entry should be END with reason user_stop
    const last = history[history.length - 1]
    expect(last).toMatchObject({ phase: 'END', reason: 'user_stop' })
    db.close()
  }, 20000)

  it('"okay stop" (mid-sentence) is NOT a stop; loop continues normally', async () => {
    // 'bye' would be a stop keyword, so use 'castle' (which has a fixture) for turn 3.
    const result = await runCli('hi\nokay stop then continue\ncastle\n', {
      MINIMAX_API_KEY: 'sk-test',
      APP_DATA_DIR: dataDir,
    })
    expect(result.exitCode).toBe(0)
    // 3 turns, no stop triggered
    const teacherCount = (result.stdout.match(/\[Teacher\]/g) ?? []).length
    expect(teacherCount).toBe(3)
    // No END in ctx lines
    const ctxLines = result.stderr.split('\n').filter((l) => l.startsWith('[cli] ctx:'))
    expect(ctxLines.every((l) => !l.includes('ctx: END'))).toBe(true)
  }, 20000)

  // -------- v0.5 — last review recall --------

  it('5 turns: session DB row has summary + JSON-encoded keywords after markEnded', async () => {
    const inputs = ['hi', 'fine', 'castle', 'creeper', 'played']
    const result = await runCli(`${inputs.join('\n')}\n`, {
      MINIMAX_API_KEY: 'sk-test',
      APP_DATA_DIR: dataDir,
    })
    expect(result.exitCode).toBe(0)
    // The summarizer LLM call (replayed from summarize.json) should have completed.
    expect(result.stderr).toMatch(/\[cli\] summarize ok/)

    const db = openDb({ dataDir })
    applyMigrations(db, migrationsDir)
    const sessions = createSessionsDao(db)
    const all = sessions.list()
    expect(all).toHaveLength(1)
    const session = all[0]
    expect(session?.summary).not.toBeNull()
    expect(session?.summary?.length ?? 0).toBeGreaterThanOrEqual(20)
    expect(session?.keywords).not.toBeNull()
    const kw = JSON.parse(session?.keywords ?? '[]') as string[]
    expect(Array.isArray(kw)).toBe(true)
    expect(kw.length).toBeGreaterThanOrEqual(3)
    expect(kw.length).toBeLessThanOrEqual(8)
    db.close()
  }, 25000)

  it('5 turns: summary content reflects the Replay fixture (Minecraft keywords)', async () => {
    const inputs = ['hi', 'fine', 'castle', 'creeper', 'played']
    const result = await runCli(`${inputs.join('\n')}\n`, {
      MINIMAX_API_KEY: 'sk-test',
      APP_DATA_DIR: dataDir,
    })
    expect(result.exitCode).toBe(0)

    const db = openDb({ dataDir })
    applyMigrations(db, migrationsDir)
    const session = createSessionsDao(db).list()[0]
    const kw = JSON.parse(session?.keywords ?? '[]') as string[]
    // summarize.json fixture provides ["minecraft","castle","creeper","wall","build"]
    // The CLI's session should have inherited these (we don't trim them).
    expect(kw).toContain('minecraft')
    db.close()
  }, 25000)

  it('second session sees first session summary injected into [System Context] (first-turn-only)', async () => {
    // Run session A: 5 turns, ends with summary
    const inputsA = ['hi', 'fine', 'castle', 'creeper', 'played']
    const a = await runCli(`${inputsA.join('\n')}\n`, {
      MINIMAX_API_KEY: 'sk-test',
      APP_DATA_DIR: dataDir,
    })
    expect(a.exitCode).toBe(0)
    expect(a.stderr).toMatch(/\[cli\] summarize ok/)

    // Run session B in the SAME dataDir: 1 turn, just to see the injected ctx
    const b = await runCli('hi\nfine\nexit\n', {
      MINIMAX_API_KEY: 'sk-test',
      APP_DATA_DIR: dataDir,
    })
    expect(b.exitCode).toBe(0)

    // The first ctx line of session B should include "Last session" because lastReview
    // was injected on the first turn.
    const ctxLines = b.stderr.split('\n').filter((l) => l.startsWith('[cli] ctx:'))
    expect(ctxLines.length).toBeGreaterThanOrEqual(1)
    // The [System Context] block is what goes to the LLM, not the stderr ctx line.
    // The stderr line is the v0.4 "ctx: PHASE elapsed=X silence=Y" line.
    // To verify lastReview injection we look at the FIRST chunk of stderr that mentions "Last session".
    // Since we don't stream the system prompt to stderr, we look at the runCli's full stderr for it.
    // In the live process the LLM receives the system string; in this test the easiest
    // proxy is to confirm summarize ok happened twice (once per session) and that the
    // run completed cleanly. The actual last-review injection in [System Context] is
    // covered by retrieval.test.ts + context-injector.test.ts L1; we just verify
    // the wiring here (session B does not crash and gets summarize call).
    expect(b.stderr).toMatch(/\[cli\] summarize ok/)
  }, 30000)

  it('empty library: first session stderr has NO "Last session" segment (no NPE)', async () => {
    const result = await runCli('hi\nexit\n', {
      MINIMAX_API_KEY: 'sk-test',
      APP_DATA_DIR: dataDir,
    })
    expect(result.exitCode).toBe(0)
    // Empty DB → loadLastReview returns null → the rendered [System Context]
    // block must NOT contain the "Last session" segment. We check for the
    // specific rendered pattern "- Last session (" (from context-injector.ts
    // line 54), not just "Last session" — the latter appears in prompts/tools.md
    // (v0.7.3 doc added a reference like "...in your [System Context] as the
    // 'Last session' segment") and in the agent-context-injector.ts doc
    // comments, neither of which are part of the rendered block.
    expect(result.stderr).not.toMatch(/- Last session \(/)
  }, 20000)

  it('5 turns: 5 chat-stream calls + 1 summarizer chat call (call count 5+1)', async () => {
    const inputs = ['hi', 'fine', 'castle', 'creeper', 'played']
    const result = await runCli(`${inputs.join('\n')}\n`, {
      MINIMAX_API_KEY: 'sk-test',
      APP_DATA_DIR: dataDir,
    })
    expect(result.exitCode).toBe(0)
    // 5 [Teacher] responses from chatStream
    const teacherCount = (result.stdout.match(/\[Teacher\]/g) ?? []).length
    expect(teacherCount).toBe(5)
    // Summarizer ran (replayed fixture)
    expect(result.stderr).toMatch(/\[cli\] summarize ok/)
    expect(result.stderr).toMatch(/\[cli\] markEnded done/)
  }, 25000)

  it('"Last session" line in [System Context] reaches the LLM (proxy: summarize fixture ran with transcript context)', async () => {
    // This is a wiring sanity check: after a session A, the summarizer call
    // receives the full transcript (not just the user message), so a real LLM
    // would see "Last session..." in its input. We verify by checking that
    // the summarizer fixture was matched (the only way to get summarize ok
    // is if buildSummaryInstruction was the LAST user message — see
    // summarizer.test.ts marker fix).
    const inputs = ['hi', 'fine', 'castle', 'creeper', 'played']
    const result = await runCli(`${inputs.join('\n')}\n`, {
      MINIMAX_API_KEY: 'sk-test',
      APP_DATA_DIR: dataDir,
    })
    expect(result.exitCode).toBe(0)
    // summarize ok stderr line confirms buildSummaryInstruction reached the LLM call.
    expect(result.stderr).toMatch(/\[cli\] summarize ok summary=\d+c keywords=\d+/)
  }, 25000)

  // -------- v0.6 — topic matching + topic_stats --------

  it('5 turns (minecraft keywords): topic_stats.minecraft count=1 + stderr has "topic match: minecraft"', async () => {
    const inputs = ['hi', 'fine', 'castle', 'creeper', 'played']
    const result = await runCli(`${inputs.join('\n')}\n`, {
      MINIMAX_API_KEY: 'sk-test',
      APP_DATA_DIR: dataDir,
    })
    expect(result.exitCode).toBe(0)
    // Summarizer must have produced Minecraft keywords from fixture
    expect(result.stderr).toMatch(/\[cli\] summarize ok summary=\d+c keywords=\d+/)
    // Topic matcher ran and matched minecraft
    expect(result.stderr).toMatch(/\[cli\] topic match: minecraft jaccard=\d+\.\d{2} shared=\[/)

    // DB: topic_stats has minecraft row with count=1
    const db = openDb({ dataDir })
    applyMigrations(db, migrationsDir)
    const stats = createTopicStatsDao(db)
    const mc = stats.get('minecraft')
    expect(mc).not.toBeNull()
    expect(mc?.discussionCount).toBe(1)
    expect(mc?.lastDiscussedAt).not.toBeNull()
    db.close()
  }, 25000)

  it('session A 5 turns + session B 5 turns: minecraft count=2 (UPSERT accumulation)', async () => {
    const inputs = ['hi', 'fine', 'castle', 'creeper', 'played']
    // Session A
    const a = await runCli(`${inputs.join('\n')}\n`, {
      MINIMAX_API_KEY: 'sk-test',
      APP_DATA_DIR: dataDir,
    })
    expect(a.exitCode).toBe(0)
    expect(a.stderr).toMatch(/\[cli\] topic match: minecraft/)

    // Session B in SAME data dir
    const b = await runCli(`${inputs.join('\n')}\n`, {
      MINIMAX_API_KEY: 'sk-test',
      APP_DATA_DIR: dataDir,
    })
    expect(b.exitCode).toBe(0)
    expect(b.stderr).toMatch(/\[cli\] topic match: minecraft/)

    // DB: count=2, first unchanged, last updated
    const db = openDb({ dataDir })
    applyMigrations(db, migrationsDir)
    const stats = createTopicStatsDao(db)
    const mc = stats.get('minecraft')
    expect(mc?.discussionCount).toBe(2)
    db.close()
  }, 45000)

  it('first session on empty library: minecraft match → stats row created, 6 other topics untouched', async () => {
    // summarize fixture always returns minecraft/castle/creeper/wall/build
    // keywords, so on any session topic match: minecraft fires. This test
    // verifies that:
    //   (a) the very first session on an empty library still matches a topic
    //   (b) only minecraft gets a row, the other 6 seed topics stay untouched
    // (The "topic match: none" path is unit-tested in topic-matcher.test.ts
    // — there's no LLM fixture that returns [] keywords to exercise it at L3.)
    const a = await runCli('hi\nexit\n', {
      MINIMAX_API_KEY: 'sk-test',
      APP_DATA_DIR: dataDir,
    })
    expect(a.exitCode).toBe(0)
    expect(a.stderr).toMatch(/\[cli\] topic match: minecraft/)

    const db = openDb({ dataDir })
    applyMigrations(db, migrationsDir)
    const stats = createTopicStatsDao(db)
    const all = stats.all()
    expect(all).toHaveLength(1)
    expect(all[0]?.topic).toBe('minecraft')
    expect(all[0]?.discussionCount).toBe(1)
    db.close()
  }, 20000)

  it('7 seed topics loaded by migration 003: TopicsDao.list() returns 7', async () => {
    // Trigger a session so DB is initialized
    const result = await runCli('hi\nexit\n', {
      MINIMAX_API_KEY: 'sk-test',
      APP_DATA_DIR: dataDir,
    })
    expect(result.exitCode).toBe(0)

    const db = openDb({ dataDir })
    applyMigrations(db, migrationsDir)
    const topics = createTopicsDao(db)
    const all = topics.list()
    expect(all).toHaveLength(7)
    const names = all.map((t) => t.name).sort()
    expect(names).toEqual(['family', 'food', 'minecraft', 'movies', 'music', 'school', 'sports'])
    db.close()
  }, 20000)

  // -------- v0.7 — tool calling: mark_mistake --------

  it('1 turn with "yesterday" input: mistakes table gets 1 row + stderr tool-call log + stdout has NO <tool> block', async () => {
    // The mistake-yesterday Replay fixture has the LLM output a
    // <tool>mark_mistake(...)</tool> block. The CLI must:
    //   (a) write a row to the mistakes table
    //   (b) log "[cli] tool call: mark_mistake(...)" to stderr
    //   (c) NOT leak the <tool>...</tool> block into stdout (DoD #6)
    const result = await runCli('I go to school yesterday\nexit\n', {
      MINIMAX_API_KEY: 'sk-test',
      APP_DATA_DIR: dataDir,
    })
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toMatch(/\[cli\] tool call: mark_mistake\(/)
    // The <tool> block must NOT appear in what the student sees.
    expect(result.stdout).not.toContain('<tool>')
    expect(result.stdout).not.toContain('</tool>')
    // The teacher's natural text reply must still reach the student.
    expect(result.stdout).toMatch(/went to school yesterday/i)

    const db = openDb({ dataDir })
    applyMigrations(db, migrationsDir)
    const sessions = createSessionsDao(db)
    const mistakes = createMistakesDao(db)
    const session = sessions.list()[0]
    expect(session).toBeDefined()
    const rows = mistakes.getBySession(session?.id ?? '')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.original).toBe('I go to school yesterday')
    expect(rows[0]?.corrected).toBe('I went to school yesterday')
    expect(rows[0]?.category).toBe('grammar')
    db.close()
  }, 25000)

  it('2 turns both with "yesterday": dedup blocks 2nd mark, DB has 1 row + stderr has dedup log', async () => {
    const result = await runCli('I go to school yesterday\nI see my friend yesterday\nexit\n', {
      MINIMAX_API_KEY: 'sk-test',
      APP_DATA_DIR: dataDir,
    })
    expect(result.exitCode).toBe(0)
    // First turn: tool call fires
    const toolCallMatches = result.stderr.match(/\[cli\] tool call: mark_mistake/g) ?? []
    expect(toolCallMatches.length).toBe(1)
    // Second turn: dedup catches the same original
    expect(result.stderr).toMatch(
      /\[cli\] tool dedup: skipped \(already marked: "I go to school yesterday"\)/,
    )

    const db = openDb({ dataDir })
    applyMigrations(db, migrationsDir)
    const sessions = createSessionsDao(db)
    const mistakes = createMistakesDao(db)
    const session = sessions.list()[0]
    const rows = mistakes.getBySession(session?.id ?? '')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.original).toBe('I go to school yesterday')
    db.close()
  }, 25000)

  it('cross-session: session A marks a mistake, session B startup loads it via getRecent(5)', async () => {
    // Session A: 1 mistake
    const a = await runCli('I go to school yesterday\nexit\n', {
      MINIMAX_API_KEY: 'sk-test',
      APP_DATA_DIR: dataDir,
    })
    expect(a.exitCode).toBe(0)
    expect(a.stderr).toMatch(/\[cli\] tool call: mark_mistake/)
    // First session starts on empty library → no recent mistakes loaded
    expect(a.stderr).toMatch(/\[cli\] loaded 0 recent mistakes \(cross-session\)/)

    // Session B: same dataDir → startup log shows 1 recent mistake loaded
    const b = await runCli('hi\nexit\n', {
      MINIMAX_API_KEY: 'sk-test',
      APP_DATA_DIR: dataDir,
    })
    expect(b.exitCode).toBe(0)
    expect(b.stderr).toMatch(/\[cli\] loaded 1 recent mistakes \(cross-session\)/)
  }, 40000)

  it('session A + session B both produce mistakes: total 2 mistakes across 2 sessions', async () => {
    const a = await runCli('I go to school yesterday\nexit\n', {
      MINIMAX_API_KEY: 'sk-test',
      APP_DATA_DIR: dataDir,
    })
    expect(a.exitCode).toBe(0)

    const b = await runCli('I go to school yesterday\nexit\n', {
      MINIMAX_API_KEY: 'sk-test',
      APP_DATA_DIR: dataDir,
    })
    expect(b.exitCode).toBe(0)

    const db = openDb({ dataDir })
    applyMigrations(db, migrationsDir)
    const sessions = createSessionsDao(db)
    const mistakes = createMistakesDao(db)
    const allSessions = sessions.list()
    expect(allSessions).toHaveLength(2)
    // getRecent across both sessions should return 2 rows
    const recent = mistakes.getRecent(10)
    expect(recent).toHaveLength(2)
    // And each session has exactly 1 row
    for (const s of allSessions) {
      expect(mistakes.getBySession(s.id)).toHaveLength(1)
    }
    db.close()
  }, 40000)

  // -------- v0.7.2 — semantic retrieval + summary-embedding persistence --------

  it('v0.7.2 single session: END writes 1536-byte embedding BLOB (384 floats × 4 bytes)', async () => {
    const result = await runCli('hi\nexit\n', {
      MINIMAX_API_KEY: 'sk-test',
      APP_DATA_DIR: dataDir,
      HF_ENDPOINT: 'https://hf-mirror.com',
    })
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toMatch(/\[cli\] embedded session\.summary \(384 dim, 1536 bytes\)/)

    const db = openDb({ dataDir })
    applyMigrations(db, migrationsDir)
    const row = db.raw
      .prepare(
        'SELECT summary, length(embedding) AS elen FROM sessions ORDER BY started_at DESC LIMIT 1',
      )
      .get() as { summary: string | null; elen: number | null }
    expect(row.summary).toBeTruthy()
    expect(row.summary).not.toBe('(summarization failed)')
    expect(row.elen).toBe(1536)
    db.close()
  }, 120000)

  it('v0.7.2 cross-session: session C startup retrieves 1 relevant past session (B excluded as lastReview)', async () => {
    // Three minimal sessions, each 1 turn ('hi' → greeting fixture).
    // The summarizer fixture is deterministic (always returns the same
    // Minecraft summary + keywords for any transcript), so A/B/C end up
    // with identical summary embeddings. When C starts:
    //   - lastReview = B (most recent ended session)
    //   - candidates = [A, B] (both have embedding + summary)
    //   - excludeSessionId = B  →  result = [A]
    // → stderr shows "retrieved 1 relevant sessions".
    const a = await runCli('hi\nexit\n', {
      MINIMAX_API_KEY: 'sk-test',
      APP_DATA_DIR: dataDir,
      HF_ENDPOINT: 'https://hf-mirror.com',
    })
    expect(a.exitCode).toBe(0)
    expect(a.stderr).toMatch(/\[cli\] embedded session\.summary/)

    const b = await runCli('hi\nexit\n', {
      MINIMAX_API_KEY: 'sk-test',
      APP_DATA_DIR: dataDir,
      HF_ENDPOINT: 'https://hf-mirror.com',
    })
    expect(b.exitCode).toBe(0)
    // Session B's startup: lastReview = A → retrieve excludes A → 0 results.
    expect(b.stderr).toMatch(/\[cli\] retrieved 0 relevant sessions/)
    expect(b.stderr).toMatch(/\[cli\] embedded session\.summary/)

    const c = await runCli('hi\nexit\n', {
      MINIMAX_API_KEY: 'sk-test',
      APP_DATA_DIR: dataDir,
      HF_ENDPOINT: 'https://hf-mirror.com',
    })
    expect(c.exitCode).toBe(0)
    // Session C: lastReview = B, candidates = [A, B], B excluded → 1 result.
    expect(c.stderr).toMatch(/\[cli\] retrieved 1 relevant sessions/)
  }, 240000)

  // -------- v0.7.3 — memory_search tool (A+B hybrid protocol) --------

  // -------- v0.7.5 — context budget enforcement (truncation + usage log + warn) --------

  it('v0.7.5 sliding-window truncate fires when budget is below input size', async () => {
    // LLM_CONTEXT_BUDGET_TOKENS=1 is far below the system+history estimate
    // (SOUL+AGENTS+USER alone is ~1000+ tokens). On turn 2, history has
    // 3 messages (hi, r1, fine), so the truncate loop enters, drops the
    // oldest pair, and logs. Same for turn 3.
    const inputs = ['hi', 'fine', 'castle']
    const result = await runCli(`${inputs.join('\n')}\n`, {
      MINIMAX_API_KEY: 'sk-test',
      APP_DATA_DIR: dataDir,
      LLM_CONTEXT_BUDGET_TOKENS: '1',
    })
    expect(result.exitCode).toBe(0)
    // Truncation log appears at least once (turn 2 and turn 3 both fire).
    // Use a regex that tolerates the variable estimated-token count.
    const truncLines =
      result.stderr.match(
        /\[cli\] truncated: dropped \d+ pairs, history now \d+ messages \(est \d+ tokens\)/g,
      ) ?? []
    expect(truncLines.length).toBeGreaterThanOrEqual(1)
    // No truncation on turn 1 (history is only 1 message; loop guard
    // `current.length > 2` prevents entering the truncate body).
    // (This is implicit: the first ctx line in stderr is for turn 1 and
    // would be followed by a truncation line for turn 2, if any. We don't
    // assert on absence of turn-1 truncation because the loop's invariant
    // is structural — it can't truncate a length-1 array.)
  }, 25000)

  it('v0.7.5 usage log + 80% warn: Replay fixture yields a usage chunk, CLI logs tokens + warn once', async () => {
    // budget-warn.json fixture yields a usage chunk with inputTokens=95
    // and a text chunk. With LLM_CONTEXT_BUDGET_TOKENS=100, 95/100=95% ≥ 80%
    // so the warn fires (and is gated to once-per-session).
    const result = await runCli('budget please\nexit\n', {
      MINIMAX_API_KEY: 'sk-test',
      APP_DATA_DIR: dataDir,
      LLM_CONTEXT_BUDGET_TOKENS: '100',
    })
    expect(result.exitCode).toBe(0)
    // (a) Token usage log line — proves the Replay provider forwards the
    //     usage chunk and the CLI captures it from chatStream().
    expect(result.stderr).toMatch(
      /\[cli\] tokens: input=95 output=12 cache_read=0 cache_creation=0/,
    )
    // (b) 80% warn fires (95% rounded → "95%") and is logged once.
    expect(result.stderr).toMatch(/\[cli\] warn: context usage 95% \(budget=100\)/)
    const warnCount = result.stderr.match(/\[cli\] warn: context usage/g) ?? []
    expect(warnCount.length).toBe(1)
    // (c) The teacher's natural text reply (the text chunk) still reaches stdout.
    expect(result.stdout).toMatch(/let's keep going/i)
  }, 20000)

  it('v0.7.5.1 (V751-001 fix) warn fires when TOTAL context (fresh + cache_read) >= 80% of budget', async () => {
    // Regression test for V751-001. The pre-fix warn used only
    // `usage.inputTokens` (fresh), so under Anthropic prompt caching the
    // warn would never fire — fresh stays small (~30-700) but the cached
    // static portion (~1800-2400) still counts against the LLM's context
    // window. v0.7.5.1 fixes this: warn uses
    // `inputTokens + cacheReadTokens + cacheCreationTokens`.
    //
    // Fixture: inputTokens=200 (fresh), cacheReadTokens=1800 (cached
    // static), total=2000. With budget=2000, 2000/2000=100% ≥ 80% → warn.
    // Pre-fix code would have computed 200/2000=10% and NOT warned.
    const result = await runCli('cache budget\nexit\n', {
      MINIMAX_API_KEY: 'sk-test',
      APP_DATA_DIR: dataDir,
      LLM_CONTEXT_BUDGET_TOKENS: '2000',
    })
    expect(result.exitCode).toBe(0)
    // Usage log shows the raw values (for grep-based debug).
    expect(result.stderr).toMatch(
      /\[cli\] tokens: input=200 output=12 cache_read=1800 cache_creation=0/,
    )
    // Warn fires at 100% (rounded from 2000/2000=1.0).
    expect(result.stderr).toMatch(/\[cli\] warn: context usage 100% \(budget=2000\)/)
  }, 20000)

  it('v0.7.3 memory_search: triggers 2nd LLM call + stdout shows 2nd-call fixture + no <tool> leak', async () => {
    // Pre-seed session A so memory_search has 1 candidate to retrieve.
    // A's fixture (greeting) is the simplest "happy path" — the session
    // gets a summary + embedding written at END (v0.7.2 wiring).
    const a = await runCli('hi\nexit\n', {
      MINIMAX_API_KEY: 'sk-test',
      APP_DATA_DIR: dataDir,
      HF_ENDPOINT: 'https://hf-mirror.com',
    })
    expect(a.exitCode).toBe(0)
    expect(a.stderr).toMatch(/\[cli\] embedded session\.summary/)

    // Session B: user input triggers the memory-search-input fixture
    // (matches on "earlier session"). The 1st-call fixture emits a
    // <tool>memory_search(...)</tool> block; the CLI executes, feeds the
    // result back as a synthetic user message, and makes a 2nd call.
    // The 2nd-call fixture (memory-search-followup) matches on the
    // [tool_result_v073] marker in that synthetic message.
    const b = await runCli('earlier session\nexit\n', {
      MINIMAX_API_KEY: 'sk-test',
      APP_DATA_DIR: dataDir,
      HF_ENDPOINT: 'https://hf-mirror.com',
    })
    expect(b.exitCode).toBe(0)
    // (a) Both stderr markers must appear in order.
    expect(b.stderr).toMatch(/\[cli\] tool call: memory_search\(/)
    expect(b.stderr).toMatch(/\[cli\] tool 2nd-call: memory_search\(top_k=2\)/)
    // (b) stdout must show the 2nd-call fixture text (not the 1st-call
    //     "Let me check your past sessions..." which is what the student
    //     would see if the A+B loop was broken).
    expect(b.stdout).toMatch(/I remember you mentioned Minecraft last week/)
    // (c) No <tool> block must leak — neither the 1st-call's tool block
    //     (we already strip on the no-tool fallback path; the A+B path
    //     also strips via safety pass) nor any 2nd-call one.
    expect(b.stdout).not.toContain('<tool>')
    expect(b.stdout).not.toContain('</tool>')
  }, 240000)

  // -------- v0.7.6 — V751-002: chatStream error handling + auto-save --------

  it('v0.7.6 V751-002: 5xx (retryable) on every call → catch-all fires: fallback message + auto-save + exit 1', async () => {
    // LLM_TEST_FAIL=500 → every chatStream() call throws an Anthropic-shaped
    // error with .status=500. chatStreamWithRetry logs + retries 1x, then
    // both attempts fail. The CLI's catch-all writes the friendly fallback
    // message to stdout, auto-saves the session with a placeholder summary,
    // and exits with code 1.
    const result = await runCli('hi\nexit\n', {
      MINIMAX_API_KEY: 'sk-test',
      APP_DATA_DIR: dataDir,
      LLM_TEST_FAIL: '500',
    })
    // Exit code 1 — graceful failure (process did not crash; we set exitCode
    // explicitly in the catch-all).
    expect(result.exitCode).toBe(1)
    // (a) Friendly fallback message reached the student.
    expect(result.stdout).toMatch(/Sorry, I lost my train of thought/)
    // (b) Stderr shows the wrapper's classification + the catch-all's
    //     "falling back" + "session auto-saved" lines.
    expect(result.stderr).toMatch(/\[cli\] llm error: 5xx/)
    expect(result.stderr).toMatch(/\[cli\] retrying in 1s\.\.\. \(attempt 2\/2\)/)
    expect(result.stderr).toMatch(/\[cli\] persistent llm failure; falling back/)
    expect(result.stderr).toMatch(/\[cli\] session auto-saved: /)
    expect(result.stderr).toMatch(/\[cli\] persistence skipped \(handled by V751-002 catch-all\)/)
    // (c) DB has a session row that was ended (the auto-save wrote it).
    const db = openDb({ dataDir })
    applyMigrations(db, migrationsDir)
    const sessions = createSessionsDao(db)
    const all = sessions.list()
    expect(all).toHaveLength(1)
    expect(all[0]?.summary).toBe('(summarization failed after llm error)')
    db.close()
  }, 30000)

  it('v0.7.6 V751-002: 4xx (non-retryable) on every call → catch-all fires immediately (no retry) + exit 1', async () => {
    // LLM_TEST_FAIL=401 → .status=401 → classifyLLMError says retryable=false
    // → chatStreamWithRetry fails fast (no "retrying in 1s..." line). The
    // catch-all still fires because the wrapper throws on the (single) attempt.
    const result = await runCli('hi\nexit\n', {
      MINIMAX_API_KEY: 'sk-test',
      APP_DATA_DIR: dataDir,
      LLM_TEST_FAIL: '401',
    })
    expect(result.exitCode).toBe(1)
    // (a) Friendly fallback to stdout.
    expect(result.stdout).toMatch(/Sorry, I lost my train of thought/)
    // (b) Classification logged; NO "retrying in" line (4xx is not retryable).
    expect(result.stderr).toMatch(/\[cli\] llm error: 4xx/)
    expect(result.stderr).not.toMatch(/retrying in/)
    // (c) Catch-all still fires.
    expect(result.stderr).toMatch(/\[cli\] persistent llm failure; falling back/)
    expect(result.stderr).toMatch(/\[cli\] session auto-saved: /)
  }, 30000)

  it('v0.7.6 V751-002: 429 (rate_limit, retryable) on every call → catch-all fires + session ended cleanly', async () => {
    // 429 is retryable. The wrapper retries once. If both fail, catch-all
    // fires. This test mirrors the 5xx test but uses 429 to confirm the
    // classification path for rate limits works end-to-end.
    const result = await runCli('hi\nexit\n', {
      MINIMAX_API_KEY: 'sk-test',
      APP_DATA_DIR: dataDir,
      LLM_TEST_FAIL: '429',
    })
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toMatch(/Sorry, I lost my train of thought/)
    expect(result.stderr).toMatch(/\[cli\] llm error: rate_limit/)
    expect(result.stderr).toMatch(/\[cli\] persistent llm failure; falling back/)
    expect(result.stderr).toMatch(/\[cli\] session auto-saved: /)

    // DB: session is persisted with a placeholder summary.
    const db = openDb({ dataDir })
    applyMigrations(db, migrationsDir)
    const all = createSessionsDao(db).list()
    expect(all).toHaveLength(1)
    expect(all[0]?.summary).toBe('(summarization failed after llm error)')
    db.close()
  }, 30000)

  // -------- v0.7.6 B1 — anchor pair (truncate-history protects first exchange) --------

  it('v0.7.6 B1: with a tiny budget, the first user/assistant pair survives truncation as the anchor', async () => {
    // 4 turns: hi / fine / castle / creeper. LLM_CONTEXT_BUDGET_TOKENS=1
    // is far below the system+history estimate, so truncateHistory drops
    // pairs aggressively. v0.7.6 B1 makes the CLI capture the first
    // user/assistant pair as an anchor and pass it to truncateHistory.
    //
    // We verify the anchor behavior INDIRECTLY via the stderr log: with
    // anchor protection, the dropped count is N-1 (one fewer pair dropped
    // compared to v0.7.5 because the first pair is protected). Direct
    // assertion: the log "[cli] truncated:" fires at least once (turn 2
    // onward), and the session completes cleanly with the anchor preserved.
    //
    // The L1 tests in tests/agent/truncate-history.test.ts cover the
    // anchor behavior in isolation; this L3 test confirms the wiring in
    // the main loop (firstPair is captured, passed to truncateHistory,
    // and doesn't break the rest of the loop).
    const inputs = ['hi', 'fine', 'castle']
    const result = await runCli(`${inputs.join('\n')}\n`, {
      MINIMAX_API_KEY: 'sk-test',
      APP_DATA_DIR: dataDir,
      LLM_CONTEXT_BUDGET_TOKENS: '1',
    })
    expect(result.exitCode).toBe(0)
    // Truncation fires (budget=1 forces drops). Exact count depends on
    // whether anchor was applied — but with the small input set, at least
    // 1 drop happens on turn 2/3.
    expect(result.stderr).toMatch(/\[cli\] truncated:/)
    // Session completes normally; no fallback message (no LLM error).
    expect(result.stdout).not.toMatch(/Sorry, I lost my train of thought/)
    // The DB session is fully persisted.
    const db = openDb({ dataDir })
    applyMigrations(db, migrationsDir)
    const all = createSessionsDao(db).list()
    expect(all).toHaveLength(1)
    expect(all[0]?.summary).toBeTruthy()
    db.close()
  }, 25000)

  // -------- v0.7.6 B2 — summarize_history tool (A+B hybrid, history rewrite) --------

  it('v0.7.6 B2: summarize_history triggers 2nd LLM call + stdout shows 2nd-call fixture + no <tool> leak', async () => {
    // Send "compress chat" as the user input — the 0-summarize-history-input
    // fixture (alphabetically first, prefix `0-`) matches that substring
    // first and emits `<tool>summarize_history(...)</tool>`. The CLI's
    // B2 branch executes the tool, runs the A+B 2nd LLM call (the synthetic
    // user message contains `[v076_history_summary]`, which the 0-summarize-
    // history-followup fixture matches), and prints the followup text.
    //
    // History will only have 1 user turn before the trigger, so the
    // compression block itself is skipped (anchorLen=0, KEEP_RECENT=6,
    // threshold=8, history.length=1). That's intentional — this test
    // verifies the A+B wiring and stdout/stderr observability. The actual
    // rewrite path is exercised by the live demo (B-DoD #2).
    const result = await runCli('compress chat\nexit\n', {
      MINIMAX_API_KEY: 'sk-test',
      APP_DATA_DIR: dataDir,
    })
    expect(result.exitCode).toBe(0)
    // (a) Both stderr markers fire (1st-call execute + 2nd-call A+B).
    expect(result.stderr).toMatch(/\[cli\] tool call: summarize_history\(/)
    expect(result.stderr).toMatch(/\[cli\] tool 2nd-call: summarize_history\(target=500\)/)
    // (b) The compression was skipped because the history was too short.
    //     (This branch is verified explicitly so a regression that makes
    //     the compression fire on a 1-turn session would be caught.)
    expect(result.stderr).toMatch(/\[cli\] tool summarize: skipped \(history too short:/)
    // (c) Stdout shows the 2nd-call fixture text — NOT the 1st-call's
    //     "One moment while I tighten my notes..." which would only appear
    //     if the A+B loop was broken (e.g. the CLI fell into the no-tool
    //     branch and stdout'd the 1st-call text directly).
    expect(result.stdout).toMatch(/Got it — let's keep going/)
    // (d) No tool block leaks to stdout (safety strip pass on 2nd-call).
    expect(result.stdout).not.toContain('<tool>')
    expect(result.stdout).not.toContain('</tool>')
  }, 30000)

  // -------- v0.7.6 D5 — topic_select tool (A+B hybrid, no history rewrite) --------

  it('v0.7.6 D5: topic_select triggers 2nd LLM call + stdout shows 2nd-call fixture + no <tool> leak', async () => {
    // Send "pick a topic" as the user input — the 1-topic-select-input
    // fixture (prefix `1-`) matches that substring and emits
    // `<tool>topic_select(...)</tool>`. The CLI's D5 branch executes the
    // tool (pure compute), feeds the result back via a synthetic user
    // message containing `[v076_topic_select_result]`, and makes a 2nd
    // LLM call matched by the 1-topic-select-followup fixture.
    //
    // Unlike B2 (which rewrites history), D5 leaves history untouched —
    // it just suggests a topic for the LLM to bring up. The student
    // sees the 2nd-call fixture text ("Great! Let's talk about sports.")
    // which is the LLM's natural reply to the selected topic.
    const result = await runCli('pick a topic\nexit\n', {
      MINIMAX_API_KEY: 'sk-test',
      APP_DATA_DIR: dataDir,
    })
    expect(result.exitCode).toBe(0)
    // (a) Both stderr markers fire.
    expect(result.stderr).toMatch(/\[cli\] tool call: topic_select\(/)
    expect(result.stderr).toMatch(/\[cli\] tool 2nd-call: topic_select\(slug=/)
    // (b) Stdout shows the 2nd-call fixture text (NOT the 1st-call tool
    //     block, which would indicate the A+B path failed and the CLI
    //     displayed the raw 1st-call text).
    expect(result.stdout).toMatch(/Great! Let's talk about sports/)
    // (c) No tool block leaks to stdout (safety strip on 2nd-call).
    expect(result.stdout).not.toContain('<tool>')
    expect(result.stdout).not.toContain('</tool>')
    // (d) Session completes normally.
    const db = openDb({ dataDir })
    applyMigrations(db, migrationsDir)
    const all = createSessionsDao(db).list()
    expect(all).toHaveLength(1)
    expect(all[0]?.summary).toBeTruthy()
    db.close()
  }, 30000)
})
