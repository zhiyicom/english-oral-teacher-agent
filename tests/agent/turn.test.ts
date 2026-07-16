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
import { createTopicSelectTool } from '../../src/agent/tools/topic-select.js'
import type { TurnEvent, TurnInput, TurnOutput } from '../../src/agent/turn.js'
import { createReplayProvider } from '../../src/llm/testing.js'
import type { LLMClient } from '../../src/llm/types.js'
import type { ChatChunk, ChatOpts, ChatResult } from '../../src/llm/types.js'
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
  const out: TurnInput = {
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
    warmUpHook: null,
    isFirstTurn: opts.isFirstTurn ?? true,
    systemPrompt: opts.harness.systemPrompt,
    mockTime: false,
  }
  return out
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

describe('runTurn (v1.0.4 §1.2 — Last session Messages[0] keyword alignment)', () => {
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

  it('first-turn WARM_UP Messages[0] emits up to 6 keywords (aligned with Block 1)', async () => {
    // v1.0.4 §1.2 — Messages[0] keywords slice changed from 0..4 to 0..6 to
    // align with Block 1. The synthetic WARM_UP hint lives in the LLM-bound
    // `callMessages` (not in `input.history`), so we install a tiny capture
    // client that records the messages it sees and then asserts on them.
    const sixKeywords = [
      'short responses',
      'low engagement',
      'cello',
      'throat',
      'homework task',
      'fish',
    ]
    let captured: { role: string; content: string }[] = []
    const capturingClient: LLMClient = {
      async *chatStream(opts: ChatOpts): AsyncIterable<never> {
        captured = opts.messages.map((m) => ({ role: m.role, content: m.content }))
        // biome-ignore lint/correctness/useYield: capture-only iterator
        throw new Error('capture-only')
      },
      async chat() {
        throw new Error('capture-only')
      },
    }

    const input = makeTurnInput({ harness, sessionId, userInput: 'hi' })
    input.lastReview = {
      sessionId: 'prev',
      startedAt: '2026-06-25T10:00:00.000Z',
      endedAt: '2026-06-25T10:25:00.000Z',
      durationMin: 25,
      summary: 'A previous session summary that mentions all six keywords.',
      keywords: sixKeywords,
      daysAgo: 1,
    }
    input.isFirstTurn = true

    const deps = {
      ...makeTurnDeps(harness),
      client: capturingClient,
    }
    const iter = runTurn(input, deps)
    try {
      while (true) {
        const next = await iter.next()
        if (next.done) break
      }
    } catch {
      // capture-only throws on iteration; we only care about `captured`
    }

    // Find the synthetic WARM_UP hint message (user role, contains "Keywords:").
    const hintMsg = captured.find((m) => m.role === 'user' && m.content.includes('Keywords:'))
    expect(hintMsg).toBeDefined()
    const hintContent = hintMsg?.content ?? ''
    expect(hintContent).toContain('Last session (1 days ago):')
    for (const kw of sixKeywords) {
      expect(hintContent).toContain(kw)
    }
  })
})

describe('runTurn (v1.1.1 P1-#5/#6 — blocked topic_select short-circuit)', () => {
  let harness: Harness
  let sessionId: string

  // A scripted LLM: chatStream emits `firstResponse` (1st call), chat()
  // records how many times the 2nd call fires and returns `followup`.
  function makeScriptedClient(opts: { firstResponse: string; followup?: string }): {
    client: LLMClient
    chatCalls: () => number
  } {
    let chatCallCount = 0
    const client: LLMClient = {
      async *chatStream(_o: ChatOpts): AsyncIterable<ChatChunk> {
        yield { type: 'text', delta: opts.firstResponse }
        yield {
          type: 'usage',
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        }
      },
      async chat(_o: ChatOpts): Promise<ChatResult> {
        chatCallCount += 1
        return { content: opts.followup ?? '2nd-call followup.' }
      },
    }
    return { client, chatCalls: () => chatCallCount }
  }

  // Register a real topic_select tool so `deps.toolRegistry.get('topic_select')`
  // resolves (an empty registry would route to the tool-unknown branch and
  // never reach the blocked short-circuit). rng=0.5 keeps selection
  // deterministic; a single topic guarantees a winner for the non-blocked
  // regression path.
  function registerTopicSelect(h: Harness): void {
    h.toolRegistry.register(
      createTopicSelectTool({
        topics: [{ name: 'friends', keywords: ['friends'], description: null, createdAt: '' }],
        stats: [],
        interests: [],
        rng: () => 0.5,
      }),
    )
  }

  async function drain(iter: AsyncGenerator<TurnEvent, TurnOutput>): Promise<{
    events: TurnEvent[]
    output: TurnOutput | undefined
  }> {
    const events: TurnEvent[] = []
    let output: TurnOutput | undefined
    while (true) {
      const next = await iter.next()
      if (next.done) {
        output = next.value
        break
      }
      events.push(next.value)
    }
    return { events, output }
  }

  beforeEach(() => {
    harness = makeHarness()
    registerTopicSelect(harness)
    const session = harness.sessions.create()
    sessionId = session.id
  })

  afterEach(() => {
    harness.db.close()
    rmSync(harness.dataDir, { recursive: true, force: true })
  })

  it('T1: blocked + non-empty strippedPrefix → uses prefix, no 2nd LLM call', async () => {
    // Fresh session → topicTurnCount=0 < minAge(5) and userInput is not an
    // explicit switch → blocked. The 1st response carries a followup after
    // the tool call; the short-circuit must surface that prefix verbatim.
    const { client, chatCalls } = makeScriptedClient({
      firstResponse:
        '<tool>topic_select({"phase":"MAIN_ACTIVITY","exclude_recent_days":30})</tool>\nNice, playing with friends sounds fun!',
    })
    const input = makeTurnInput({
      harness,
      sessionId,
      userInput: 'we played tag at recess',
      isFirstTurn: false,
    })
    const deps = { ...makeTurnDeps(harness), client }
    const { events } = await drain(runTurn(input, deps))

    const studentTexts = events.filter((e) => e.type === 'student-text')
    expect(studentTexts).toHaveLength(1)
    if (studentTexts[0]?.type === 'student-text') {
      expect(studentTexts[0].text).toBe('Nice, playing with friends sounds fun!\n\n')
    }
    // No 2nd LLM call fired.
    expect(chatCalls()).toBe(0)
    // Only one assistant message in history (user + assistant = 2 total).
    const assistants = input.history.filter((m) => m.role === 'assistant')
    expect(assistants).toHaveLength(1)
    expect(assistants[0]?.content).toBe('Nice, playing with friends sounds fun!')
  })

  it('T2: blocked + empty strippedPrefix → deterministic fallback, no 2nd LLM call', async () => {
    // 1st response is ONLY the tool call (no followup text). The
    // short-circuit must emit the deterministic one-liner instead of
    // asking the LLM again.
    const { client, chatCalls } = makeScriptedClient({
      firstResponse:
        '<tool>topic_select({"phase":"MAIN_ACTIVITY","exclude_recent_days":30})</tool>',
    })
    const input = makeTurnInput({
      harness,
      sessionId,
      userInput: 'yeah',
      isFirstTurn: false,
    })
    const deps = { ...makeTurnDeps(harness), client }
    const { events } = await drain(runTurn(input, deps))

    const studentTexts = events.filter((e) => e.type === 'student-text')
    expect(studentTexts).toHaveLength(1)
    if (studentTexts[0]?.type === 'student-text') {
      expect(studentTexts[0].text).toBe("Let's keep going with this — tell me more.\n\n")
    }
    expect(chatCalls()).toBe(0)
  })

  it('T3: not blocked (explicit switch) → 2nd LLM call runs (regression)', async () => {
    // Explicit "switch topic" bypasses the MIN_TOPIC_AGE gate, so the tool
    // executes and the normal A+B 2nd-call path runs — preserving v1.1.0
    // behavior (strippedPrefix prepended to the 2nd-call followup).
    const { client, chatCalls } = makeScriptedClient({
      firstResponse:
        '<tool>topic_select({"phase":"MAIN_ACTIVITY","exclude_recent_days":30})</tool>\nGreat, let me pick something new.',
      followup: 'So, tell me about your friends!',
    })
    const input = makeTurnInput({
      harness,
      sessionId,
      userInput: "let's switch topic",
      isFirstTurn: false,
    })
    const deps = { ...makeTurnDeps(harness), client }
    const { events } = await drain(runTurn(input, deps))

    // 2nd LLM call fired exactly once.
    expect(chatCalls()).toBe(1)
    const studentTexts = events.filter((e) => e.type === 'student-text')
    expect(studentTexts).toHaveLength(1)
    if (studentTexts[0]?.type === 'student-text') {
      // v1.1.0: strippedPrefix prepended before the 2nd-call followup.
      expect(studentTexts[0].text).toBe(
        'Great, let me pick something new.\n\nSo, tell me about your friends!\n\n',
      )
    }
  })
})

describe('runTurn (v1.1.2 P1-A — blocked tier ladder + fresh hints)', () => {
  let harness: Harness
  let sessionId: string

  // Scripted LLM: chatStream emits firstResponse (1st call), chat() returns
  // a deterministic 2nd-call followup if it ever fires. Tests assert whether
  // the 2nd call ran (v1.1.2 short-circuits it on the blocked branch).
  function makeScriptedClient(opts: { firstResponse: string; followup?: string }): {
    client: LLMClient
    chatCalls: () => number
  } {
    let chatCallCount = 0
    const client: LLMClient = {
      async *chatStream(_o: ChatOpts): AsyncIterable<ChatChunk> {
        yield { type: 'text', delta: opts.firstResponse }
        yield {
          type: 'usage',
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        }
      },
      async chat(_o: ChatOpts): Promise<ChatResult> {
        chatCallCount += 1
        return { content: opts.followup ?? '2nd-call followup.' }
      },
    }
    return { client, chatCalls: () => chatCallCount }
  }

  function registerTopicSelect(h: Harness): void {
    h.toolRegistry.register(
      createTopicSelectTool({
        topics: [{ name: 'friends', keywords: ['friends'], description: null, createdAt: '' }],
        stats: [],
        interests: [],
        rng: () => 0.5,
      }),
    )
  }

  // Library fixture for the fresh-hint tests: 3 topics, all with hit_count=0
  // keywords (mirrors the 7/16 DB state where 673 fresh keywords exist).
  const libraryTopics = [
    { name: 'travel', keywords: ['beach', 'plane'], description: 'Travel stories', createdAt: '' },
    { name: 'food', keywords: ['pizza', 'sushi'], description: 'Food culture', createdAt: '' },
    { name: 'music', keywords: ['guitar', 'piano'], description: 'Music taste', createdAt: '' },
  ]
  const libraryKeywordHits = libraryTopics.map((t) =>
    t.keywords.map((k) => ({
      topic: t.name,
      keyword: k,
      hitCount: 0,
      firstHitAt: null,
      lastHitAt: null,
    })),
  ).flat()

  async function drain(iter: AsyncGenerator<TurnEvent, TurnOutput>): Promise<{
    events: TurnEvent[]
    output: TurnOutput | undefined
  }> {
    const events: TurnEvent[] = []
    let output: TurnOutput | undefined
    while (true) {
      const next = await iter.next()
      if (next.done) {
        output = next.value
        break
      }
      events.push(next.value)
    }
    return { events, output }
  }

  async function runBlockedTurn(opts: {
    harness: Harness
    sessionId: string
    userInput: string
    firstResponse: string
    topics?: Array<{ name: string; keywords: string[]; description: string | null; createdAt: string }>
    keywordHits?: Array<{ topic: string; keyword: string; hitCount: number; firstHitAt: string | null; lastHitAt: string | null }>
    blockedCountRef?: { value: number }
  }): Promise<{
    events: TurnEvent[]
    output: TurnOutput | undefined
    input: ReturnType<typeof makeTurnInput>
    chatCalls: () => number
  }> {
    const { client, chatCalls } = makeScriptedClient({ firstResponse: opts.firstResponse })
    const input = makeTurnInput({
      harness: opts.harness,
      sessionId: opts.sessionId,
      userInput: opts.userInput,
      isFirstTurn: false,
    })
    const deps = {
      ...makeTurnDeps(opts.harness),
      client,
      topics: opts.topics ?? libraryTopics,
      keywordHits: opts.keywordHits ?? libraryKeywordHits,
      blockedCountRef: opts.blockedCountRef ?? { value: 0 },
    }
    const { events, output } = await drain(runTurn(input, deps))
    return { events, output, input, chatCalls }
  }

  beforeEach(() => {
    harness = makeHarness()
    registerTopicSelect(harness)
    const session = harness.sessions.create()
    sessionId = session.id
  })

  afterEach(() => {
    harness.db.close()
    rmSync(harness.dataDir, { recursive: true, force: true })
  })

  // ---- Tier-ladder tests (B-T1, B-T2, B-T3) -----------------------------

  it('B-T1: blocked 1st time (blockedCountRef.value=0 → tier 1) → identical to v1.1.1 fallback', async () => {
    const blockedCountRef = { value: 0 }
    const { events, input, chatCalls } = await runBlockedTurn({
      harness,
      sessionId,
      userInput: 'yeah',
      firstResponse: '<tool>topic_select({"phase":"MAIN_ACTIVITY","exclude_recent_days":30})</tool>',
      blockedCountRef,
    })

    const studentText = events.find((e) => e.type === 'student-text')
    expect(studentText).toBeDefined()
    if (studentText && studentText.type === 'student-text') {
      // Tier 1: pure continuation, NO fresh hint injected.
      expect(studentText.text).toBe("Let's keep going with this — tell me more.\n\n")
      expect(studentText.text).not.toContain('Fresh angles')
    }
    // No 2nd LLM call.
    expect(chatCalls()).toBe(0)
    // Tier counter advanced.
    expect(blockedCountRef.value).toBe(1)
    // History only got one assistant message.
    expect(input.history.filter((m) => m.role === 'assistant')).toHaveLength(1)
  })

  it('B-T2: blocked 2nd time (blockedCountRef.value=1 → tier 2) → keyword-only hint', async () => {
    const blockedCountRef = { value: 1 }
    const { events, chatCalls } = await runBlockedTurn({
      harness,
      sessionId,
      userInput: 'yeah',
      firstResponse: '<tool>topic_select({"phase":"MAIN_ACTIVITY","exclude_recent_days":30})</tool>',
      blockedCountRef,
    })

    const studentText = events.find((e) => e.type === 'student-text')
    expect(studentText).toBeDefined()
    if (studentText && studentText.type === 'student-text') {
      // Tier 2: tier-2 ladder line + keyword-only hint.
      expect(studentText.text).toMatch(/didn't take/)
      expect(studentText.text).toContain('Fresh angles to try:')
      // No topic layer (tier 3 exclusive).
      expect(studentText.text).not.toContain('Try switching to:')
    }
    expect(chatCalls()).toBe(0)
    expect(blockedCountRef.value).toBe(2)
  })

  it('B-T3: blocked 3rd time (blockedCountRef.value=2 → tier 3) → dual layer topic+keyword hint', async () => {
    const blockedCountRef = { value: 2 }
    const { events, chatCalls } = await runBlockedTurn({
      harness,
      sessionId,
      userInput: 'yeah',
      firstResponse: '<tool>topic_select({"phase":"MAIN_ACTIVITY","exclude_recent_days":30})</tool>',
      blockedCountRef,
    })

    const studentText = events.find((e) => e.type === 'student-text')
    expect(studentText).toBeDefined()
    if (studentText && studentText.type === 'student-text') {
      // Tier 3: tier-3 ladder line + dual layer (keywords + topics).
      expect(studentText.text).toMatch(/keep circling/)
      expect(studentText.text).toContain('Fresh angles to try:')
      expect(studentText.text).toContain('Try switching to:')
    }
    expect(chatCalls()).toBe(0)
    expect(blockedCountRef.value).toBe(3)
  })

  // ---- Hint-content tests (B-F1, B-F2, B-F3) ----------------------------

  it('B-F1: tier 1 emits NO hint suffix (no "Fresh angles" / "Try switching to")', async () => {
    const { events } = await runBlockedTurn({
      harness,
      sessionId,
      userInput: 'yeah',
      firstResponse:
        '<tool>topic_select({"phase":"MAIN_ACTIVITY","exclude_recent_days":30})</tool>',
      blockedCountRef: { value: 0 },
    })
    const studentText = events.find((e) => e.type === 'student-text')
    if (studentText && studentText.type === 'student-text') {
      expect(studentText.text).not.toContain('Fresh angles')
      expect(studentText.text).not.toContain('Try switching to:')
    }
  })

  it('B-F2: tier 2 hint contains the keyword names but NOT topic names', async () => {
    const { events } = await runBlockedTurn({
      harness,
      sessionId,
      userInput: 'yeah',
      firstResponse:
        '<tool>topic_select({"phase":"MAIN_ACTIVITY","exclude_recent_days":30})</tool>',
      blockedCountRef: { value: 1 },
    })
    const studentText = events.find((e) => e.type === 'student-text')
    if (studentText && studentText.type === 'student-text') {
      // Should mention at least one of our fixture keywords.
      const hasKeyword = ['beach', 'plane', 'pizza', 'sushi', 'guitar', 'piano'].some((kw) =>
        studentText.text.includes(kw),
      )
      expect(hasKeyword).toBe(true)
      // Should NOT mention topic names (tier 3 exclusive).
      const hasTopicName = ['travel', 'food', 'music'].some((t) =>
        studentText.text.includes(t),
      )
      expect(hasTopicName).toBe(false)
    }
  })

  it('B-F3: tier 3 hint contains BOTH keyword names AND topic descriptions', async () => {
    const { events } = await runBlockedTurn({
      harness,
      sessionId,
      userInput: 'yeah',
      firstResponse:
        '<tool>topic_select({"phase":"MAIN_ACTIVITY","exclude_recent_days":30})</tool>',
      blockedCountRef: { value: 2 },
    })
    const studentText = events.find((e) => e.type === 'student-text')
    if (studentText && studentText.type === 'student-text') {
      // Both layers must be present.
      expect(studentText.text).toContain('Fresh angles to try:')
      expect(studentText.text).toContain('Try switching to:')
      // Topic descriptions (not names) appear in the layer-3 hint.
      expect(studentText.text).toContain('Travel stories')
      expect(studentText.text).toContain('Food culture')
      expect(studentText.text).toContain('Music taste')
    }
  })
})
