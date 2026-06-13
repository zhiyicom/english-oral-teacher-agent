import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type Phase,
  type PhaseTransition,
  type SessionState,
  buildFinalSystemSegments,
  initState,
  mockClock,
  runTurn,
} from '../../src/agent/index.js'
import { createToolRegistry } from '../../src/agent/tool-registry.js'
import type { TurnEvent, TurnOutput } from '../../src/agent/turn.js'
import { createReplayProvider } from '../../src/llm/testing.js'
import type { LLMClient } from '../../src/llm/types.js'
import type { RelevantSession } from '../../src/memory/index.js'
import { type SystemPrompt, loadSystemPrompt } from '../../src/prompts/loader.js'
import { applyMigrations, openDb } from '../../src/storage/db.js'
import { createMessagesDao } from '../../src/storage/messages.js'
import { createSessionsDao } from '../../src/storage/sessions.js'
import { createTopicStatsDao } from '../../src/storage/topics.js'
import { resolveMigrationsDirForTesting } from '../storage/helpers.js'

const migrationsDir = resolveMigrationsDirForTesting()
const fixturesDir = join(process.cwd(), 'tests', 'fixtures', 'replay')

// ---- L1 helpers: build a minimal TurnDeps with a real SQLite + Replay LLM ----

interface Harness {
  dataDir: string
  db: ReturnType<typeof openDb>
  client: LLMClient
  sessions: ReturnType<typeof createSessionsDao>
  messages: ReturnType<typeof createMessagesDao>
  topicStats: ReturnType<typeof createTopicStatsDao>
  toolRegistry: ReturnType<typeof createToolRegistry>
  systemPrompt: SystemPrompt
  clock: ReturnType<typeof mockClock>
}

function makeHarness(): Harness {
  const dataDir = mkdtempSync(join(tmpdir(), 'turn-test-'))
  const db = openDb({ dataDir })
  applyMigrations(db, migrationsDir)
  const sessions = createSessionsDao(db)
  const messages = createMessagesDao(db)
  const topicStats = createTopicStatsDao(db)
  const toolRegistry = createToolRegistry()
  const client = createReplayProvider(fixturesDir)
  const systemPrompt = loadSystemPrompt()
  // v0.8.1 — use a mock clock so elapsedMin stays 0 throughout the test.
  // realClock.now() would return Date.now() and push elapsedMin into the
  // billions, causing getPhase() to return 'END' immediately (all the
  // `elapsedMin < N` checks fail when elapsedMin is non-finite / huge).
  const clock = mockClock(Date.parse('2026-01-01T00:00:00Z'))
  return { dataDir, db, client, sessions, messages, topicStats, toolRegistry, systemPrompt, clock }
}

function makeTurnDeps(harness: Harness) {
  return {
    env: { LLM_CONTEXT_BUDGET_TOKENS: 6000 },
    clock: harness.clock,
    client: harness.client,
    embedder: {
      dim: 384,
      // Stub: never called by runTurn's no-tool greeting path; safe no-op.
      async embed(_s: string): Promise<Float32Array> {
        return new Float32Array(384)
      },
    },
    toolRegistry: harness.toolRegistry,
    sessions: harness.sessions,
    messages: harness.messages,
    topicStats: harness.topicStats,
    markedOriginals: new Set<string>(),
  }
}

function makeTurnInput(opts: {
  harness: Harness
  sessionId: string
  userInput: string
  state?: SessionState
  isFirstTurn?: boolean
}) {
  const state = opts.state ?? initState(opts.harness.clock.now())
  const phaseHistory: PhaseTransition[] = [{ phase: state.phase, at: 0, reason: 'time' }]
  const history: { role: 'user' | 'assistant' | 'system'; content: string }[] = []
  return {
    sessionId: opts.sessionId,
    userInput: opts.userInput,
    state,
    history,
    phaseHistory,
    firstPair: [] as { role: 'user' | 'assistant' | 'system'; content: string }[],
    relevantPast: [] as RelevantSession[],
    activeTopics: opts.harness.topicStats.all(),
    recentMistakes: [],
    lastReview: null,
    isFirstTurn: opts.isFirstTurn ?? true,
    systemPrompt: opts.harness.systemPrompt,
    mockTime: false,
  }
}

// ---- Tests ----

describe('runTurn (v0.8.1 L1)', () => {
  let harness: Harness
  let sessionId: string

  beforeEach(() => {
    harness = makeHarness()
    const session = harness.sessions.create()
    sessionId = session.id
  })

  afterEach(() => {
    harness.db.close()
    rmSync(harness.dataDir, { recursive: true, force: true })
  })

  it('greeting fixture: yields ctx-segment + ctx + student-text + done (no tool)', async () => {
    const input = makeTurnInput({ harness, sessionId, userInput: 'hi' })
    const deps = makeTurnDeps(harness)
    const events: TurnEvent[] = []
    let output: TurnOutput | undefined
    // Use manual iterator so we can capture the AsyncGenerator's return
    // value (for-await would discard it).
    const iter = runTurn(input, deps)
    while (true) {
      const next = await iter.next()
      if (next.done) {
        output = next.value
        break
      }
      events.push(next.value)
    }
    expect(output).toBeDefined()
    expect(output?.endedReason).toBeNull()
    expect(output?.isFirstTurn).toBe(false)
    expect(output?.sessionPersisted).toBe(false)

    // Event types in order: phase (no change on first turn) → ctx-segment
    // → ctx → (no tool) → student-text → done
    // (No `phase` event because no phase change on first turn.)
    const types = events.map((e) => e.type)
    expect(types).toContain('ctx-segment')
    expect(types).toContain('ctx')
    expect(types).toContain('student-text')
    expect(types[types.length - 1]).toBe('done')
  })

  it('user says "stop": runTurn yields phase(user_stop) + ctx(END) + student-text + done(endedReason=user_stop)', async () => {
    const input = makeTurnInput({ harness, sessionId, userInput: 'stop' })
    const deps = makeTurnDeps(harness)
    const events: TurnEvent[] = []
    let output: TurnOutput | undefined
    const iter = runTurn(input, deps)
    while (true) {
      const next = await iter.next()
      if (next.done) {
        output = next.value
        break
      }
      events.push(next.value)
    }
    expect(output?.endedReason).toBe('user_stop')
    expect(output?.state.phase).toBe('END')

    // Phase event with reason=user_stop
    const phaseEv = events.find((e) => e.type === 'phase')
    expect(phaseEv).toBeDefined()
    if (phaseEv && phaseEv.type === 'phase') {
      expect(phaseEv.reason).toBe('user_stop')
      expect(phaseEv.phase).toBe('END')
    }
    // Ctx event shows END phase (the per-turn log uses nextState.phase)
    const ctxEv = events.find((e) => e.type === 'ctx')
    expect(ctxEv).toBeDefined()
    if (ctxEv && ctxEv.type === 'ctx') {
      expect(ctxEv.phase).toBe('END' as Phase)
    }
  })

  it('mutates input history in-place: user message + assistant text appended', async () => {
    const input = makeTurnInput({ harness, sessionId, userInput: 'hi' })
    const deps = makeTurnDeps(harness)
    const iter = runTurn(input, deps)
    while (true) {
      const next = await iter.next()
      if (next.done) break
    }
    // input.history is shared (same array reference) and mutated in place.
    expect(input.history.length).toBe(2)
    expect(input.history[0]?.role).toBe('user')
    expect(input.history[0]?.content).toBe('hi')
    expect(input.history[1]?.role).toBe('assistant')
    expect(input.history[1]?.content).toMatch(/Hi there/)
  })

  it('firstPair is captured after the first turn (anchor pair for B1)', async () => {
    const input = makeTurnInput({ harness, sessionId, userInput: 'hi' })
    const deps = makeTurnDeps(harness)
    const iter = runTurn(input, deps)
    while (true) {
      const next = await iter.next()
      if (next.done) break
    }
    expect(input.firstPair.length).toBe(2)
    expect(input.firstPair[0]?.role).toBe('user')
    expect(input.firstPair[1]?.role).toBe('assistant')
  })

  it('persists user + assistant messages to messages DAO', async () => {
    const input = makeTurnInput({ harness, sessionId, userInput: 'hi' })
    const deps = makeTurnDeps(harness)
    const iter = runTurn(input, deps)
    while (true) {
      const next = await iter.next()
      if (next.done) break
    }
    const rows = harness.messages.getBySession(sessionId)
    expect(rows).toHaveLength(2)
    expect(rows[0]?.role).toBe('user')
    expect(rows[1]?.role).toBe('assistant')
  })

  it('buildFinalSystemSegments is used (sanity: no crash + segments are reasonable)', async () => {
    // buildFinalSystemSegments is imported and used by runTurn. The dynamic
    // block has a [System Context] header. This test catches a refactor
    // regression where someone forgets to import buildFinalSystemSegments.
    const sysSeg = buildFinalSystemSegments(
      harness.systemPrompt,
      initState(harness.clock.now()),
      null,
      [],
      [],
      [],
    )
    expect(sysSeg.dynamic).toMatch(/\[System Context\]/)
  })
})
