import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { type Interface, createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'
import {
  type Clock,
  type LastReview,
  type Phase,
  type PhaseTransition,
  type SessionState,
  applyEvent,
  buildFinalSystem,
  createMarkMistakeTool,
  createToolRegistry,
  initState,
  loadLastReview,
  matchTopic,
  mockClock,
  parseToolCall,
  realClock,
  stripToolCall,
  summarize,
} from './agent/index.js'
import { loadEnv } from './config/env.js'
import { createAnthropicProvider } from './llm/anthropic.js'
import { createReplayProvider } from './llm/testing.js'
import type { LLMClient, Message } from './llm/types.js'
import {
  type RelevantSession,
  createTransformersEmbedder,
  retrieveRelevant,
} from './memory/index.js'
import { type SystemPrompt, loadSystemPrompt } from './prompts/loader.js'
import {
  type Mistake,
  type TopicStat,
  applyMigrations,
  createMessagesDao,
  createMistakesDao,
  createSessionsDao,
  createTopicStatsDao,
  createTopicsDao,
  openDb,
} from './storage/index.js'

function selectClient(env: ReturnType<typeof loadEnv>, fixturesDir: string): LLMClient {
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

function selectClock(): Clock {
  if (process.env.MOCK_TIME === '1') {
    const initial = Date.parse(process.env.MOCK_NOW ?? '2026-01-01T00:00:00Z')
    return mockClock(initial)
  }
  return realClock
}

function printBanner(sp: SystemPrompt): void {
  const profile = sp.userProfile
  console.log('English Oral Teacher Agent — CLI mode')
  console.log(`Persona target: ${profile.name} (age ${profile.age}, ${profile.level})`)
  console.log('Type "exit" to quit.\n')
}

// Buffered line reader — see v0.3 commit ef78cae for the readline bug this
// was written to fix. KEPT here because it's still needed: we don't use
// rl.question() because its callback never fires on EOF.
function createLineReader(rl: Interface): {
  next: () => Promise<string>
  writePrompt: (s: string) => void
} {
  const queue: string[] = []
  let closed = false
  let waiter: ((line: string) => void) | null = null

  rl.on('line', (line) => {
    if (waiter) {
      const w = waiter
      waiter = null
      w(line)
    } else {
      queue.push(line)
    }
  })
  rl.on('close', () => {
    closed = true
    if (waiter) {
      const w = waiter
      waiter = null
      w('')
    }
  })

  return {
    next(): Promise<string> {
      if (queue.length > 0) return Promise.resolve(queue.shift() ?? '')
      if (closed) return Promise.resolve('')
      return new Promise((resolve) => {
        waiter = resolve
      })
    },
    writePrompt(prompt: string): void {
      process.stdout.write(prompt)
    },
  }
}

// v0.4 — strict whole-sentence stop regex.
//   - keyword must be at sentence start (preceded by ^, [.!?]\s+, or \n)
//   - keyword must end the input (followed by [.!?\s]* only)
//   - "let's stop and continue" → stop is mid-sentence, NOT matched
//   - "I don't want to stop." → stop preceded by space (not [.!?]), NOT matched
//   - "stop", "Stop.", "okay. stop" → matched
const STOP_REGEX = /(?:^|[.!?]\s+|\n)(stop|quit|end|bye|done|结束|停)\b[.!?\s]*$/i

export async function main(): Promise<void> {
  const env = loadEnv()
  const clock = selectClock()
  const mockTime = process.env.MOCK_TIME === '1'

  // Open SQLite + run migrations + create session row
  const db = openDb({ dataDir: env.APP_DATA_DIR })
  applyMigrations(db)
  const sessions = createSessionsDao(db)
  const messages = createMessagesDao(db)
  const topics = createTopicsDao(db)
  const topicStats = createTopicStatsDao(db)
  const session = sessions.create()

  const systemPrompt = loadSystemPrompt()

  const fixturesDir = resolve('tests/fixtures/replay')
  const client = selectClient(env, fixturesDir)

  const history: Message[] = []
  const phaseHistory: PhaseTransition[] = []
  let state: SessionState = initState(clock.now())
  phaseHistory.push({ phase: state.phase, at: 0, reason: 'time' })
  let exitReason: 'user_exit' | 'user_stop' | 'phase_end' = 'user_exit'

  // v0.5 — load the most recent session's summary for [System Context] injection.
  // Injected only on the FIRST turn of this session (first-turn-only per v0.5 design §2.5).
  const lastReview: LastReview | null = loadLastReview(db)
  let isFirstTurn = true

  // v0.6 — load aggregated topic_stats once at startup. Unlike lastReview
  // (per-session retrospective, first-turn-only), active topics are a
  // cross-session aggregate that stays useful for the WHOLE session, so we
  // pass the same list to every turn. Re-read each turn is unnecessary:
  // topic_stats is only mutated in the finally block of THIS process, after
  // the loop ends, so within-session reading once is correct.
  const activeTopics: TopicStat[] = topicStats.all()

  // v0.7 — register tools. mark_mistake is bound to this session's id so the
  // LLM never has to pass sessionId (and can't cross sessions by accident).
  const toolRegistry = createToolRegistry()
  toolRegistry.register(createMarkMistakeTool(db, session.id))

  // v0.7.1 — load recent cross-session mistakes once at startup. The CLI
  // ALSO has its own mistakesDao instance separate from the one created
  // inside the mark_mistake factory above. Both DAOs are stateless (the
  // prepared statements are independent, and there's no shared cache), so
  // running two instances against the same db handle is fine.
  const mistakesDao = createMistakesDao(db)
  const recentMistakes: Mistake[] = mistakesDao.getRecent(5)
  process.stderr.write(`[cli] loaded ${recentMistakes.length} recent mistakes (cross-session)\n`)

  // v0.7.2 — semantic retrieval of relevant past sessions. Seeded by the
  // previous session's keywords (lastReview), excluding lastReview itself
  // (already injected by the "Last session" segment). The embedder is lazy:
  // the transformers.js pipeline only loads on the first embed() call, so
  // creating the instance here is essentially free. Skip retrieval if there
  // is no lastReview or no keywords to seed the query. Failures degrade
  // gracefully to an empty result — the CLI never blocks on this.
  const embedder = createTransformersEmbedder()
  let relevantPast: RelevantSession[] = []
  if (lastReview && lastReview.keywords.length > 0) {
    try {
      const queryText = lastReview.keywords.join(' ')
      const queryVec = await embedder.embed(queryText)
      const candidates = sessions.listWithEmbeddings()
      relevantPast = retrieveRelevant({
        candidates,
        queryVec,
        topK: 2,
        excludeSessionId: lastReview.sessionId,
      })
      process.stderr.write(
        `[cli] retrieved ${relevantPast.length} relevant sessions (query="${queryText}")\n`,
      )
    } catch (err) {
      process.stderr.write(`[cli] retrieve relevant failed: ${(err as Error).message}\n`)
    }
  }

  // v0.7.1 — dedup set for mark_mistake. Whole-session scope (simpler than a
  // sliding window and good enough for ~30 turn sessions). Reset on each
  // process start, so a brand-new CLI invocation gets a fresh dedup view.
  const markedOriginals = new Set<string>()

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  })

  rl.on('SIGINT', () => {
    rl.close()
  })

  const reader = createLineReader(rl)

  printBanner(systemPrompt)

  try {
    while (true) {
      const raw = await reader.next()
      if (raw === '') break
      const input = raw.trim()
      if (input === '' || input.toLowerCase() === 'exit') break

      // Tick first — this may push us into END via time-based transition
      const phaseBeforeTick = state.phase
      state = applyEvent(state, { type: 'TICK' }, clock)
      if (state.phase !== phaseBeforeTick) {
        phaseHistory.push({
          phase: state.phase,
          at: state.elapsedMin,
          reason: 'time',
        })
        process.stderr.write(
          `[cli] phase → ${state.phase} (elapsed=${state.elapsedMin.toFixed(1)} min)\n`,
        )
      }

      // Time-based END: stop the loop, no more LLM calls
      if (state.phase === 'END') {
        process.stderr.write('[cli] session ended (time-based, 30 min reached)\n')
        exitReason = 'phase_end'
        break
      }

      // Detect stop keyword (still call LLM this turn for the goodbye)
      const isStop = STOP_REGEX.test(input)
      if (isStop) {
        state = applyEvent(state, { type: 'USER_STOP' }, clock)
        phaseHistory.push({
          phase: 'END',
          at: state.elapsedMin,
          reason: 'user_stop',
        })
        process.stderr.write(
          `[cli] phase → END (user_stop, elapsed=${state.elapsedMin.toFixed(1)} min)\n`,
        )
        exitReason = 'user_stop'
      } else {
        state = applyEvent(state, { type: 'USER_MSG' }, clock)
      }

      history.push({ role: 'user', content: input })
      messages.append({ sessionId: session.id, role: 'user', content: input })

      const system = buildFinalSystem(
        systemPrompt,
        state,
        isFirstTurn ? lastReview : null,
        activeTopics,
        recentMistakes,
        isFirstTurn ? relevantPast : [],
      )
      // After the first buildFinalSystem call, freeze the last-review injection —
      // subsequent turns build the system string from a fresh state but without
      // the review (which would otherwise drift / look stale 25 min in).
      const wasFirstTurn = isFirstTurn
      isFirstTurn = false
      // Surface the [System Context] block on stderr so L3 tests can verify
      // what phase the LLM sees (and so users can debug phase behavior live).
      process.stderr.write(
        `[cli] ctx: ${state.phase} elapsed=${state.elapsedMin.toFixed(1)} silence=${state.silenceMin.toFixed(1)}\n`,
      )
      // v0.7.2 — also dump the full rendered [System Context] block on the
      // FIRST turn so live demos and grep-based verification can see the
      // "Relevant past sessions" segment without parsing stdout (the LLM
      // response is replay-fixture text, not a copy of the system prompt).
      // First-turn-only because the lastReview/relevantPast injection is
      // first-turn-only too — the block would be identical on later turns
      // and would just spam stderr. One extra block per session, not per turn.
      if (wasFirstTurn) {
        // Extract just the [System Context] block from the full system prompt
        // (the LLM-bound system string is base + persona + block). Easier to
        // build it again with the same args than to parse the assembled string.
        const ctxBlock =
          buildFinalSystem(
            systemPrompt,
            state,
            lastReview,
            activeTopics,
            recentMistakes,
            relevantPast,
          ).split('[System Context]')[1] ?? ''
        process.stderr.write(`[cli] ctx-block:\n[System Context]${ctxBlock}\n`)
      }
      reader.writePrompt('[Teacher]: ')
      // v0.7 — buffer the full response BEFORE writing to stdout. We need to
      // strip any <tool>...</tool> block before the student sees it (the
      // tool block is an internal CLI signal, not student-facing text). The
      // performance impact is negligible (50-200 tokens per turn) and the
      // existing L3 tests only assert on the final stdout string, so this
      // is not a breaking change for tests.
      let response = ''
      for await (const chunk of client.chatStream({
        system,
        messages: history,
      })) {
        if (chunk.type === 'text') {
          response += chunk.delta
        }
      }

      // v0.7 — parse + execute + strip the tool block, then write the
      // student-facing text. Tool failures (parse/schema/execute) are
      // logged to stderr and skipped; they never block the conversation
      // because mark_mistake is best-effort.
      let display = response
      let parsed: ReturnType<typeof parseToolCall> = null
      try {
        parsed = parseToolCall(response)
      } catch (err) {
        process.stderr.write(`[cli] tool parse error: ${(err as Error).message}\n`)
      }
      if (parsed) {
        display = stripToolCall(response, parsed)
        const tool = toolRegistry.get(parsed.name)
        if (!tool) {
          process.stderr.write(`[cli] tool unknown: ${parsed.name}\n`)
        } else {
          const original = typeof parsed.args.original === 'string' ? parsed.args.original : ''
          if (parsed.name === 'mark_mistake' && original && markedOriginals.has(original)) {
            process.stderr.write(`[cli] tool dedup: skipped (already marked: "${original}")\n`)
          } else {
            try {
              tool.execute(parsed.args)
              if (parsed.name === 'mark_mistake' && original) {
                markedOriginals.add(original)
              }
              process.stderr.write(
                `[cli] tool call: ${parsed.name}(${JSON.stringify(parsed.args)})\n`,
              )
            } catch (err) {
              process.stderr.write(`[cli] tool execute error: ${(err as Error).message}\n`)
            }
          }
        }
      }

      process.stdout.write(`${display}\n\n`)
      history.push({ role: 'assistant', content: display })
      messages.append({ sessionId: session.id, role: 'assistant', content: display })

      // MOCK_TIME: advance the fake clock by 1 min per turn so the
      // state machine sees time progress without real waiting.
      if (mockTime && clock !== realClock) {
        ;(clock as ReturnType<typeof mockClock>).advance(60_000)
      }
    }
  } finally {
    // Persist the session as ended and close the DB regardless of how we exit.
    try {
      // v0.5 — call the summarizer over the full session transcript. On any
      // failure (LLM error / JSON parse / schema mismatch) fall back to a
      // placeholder summary so markEnded can still write and the session
      // is not lost.
      const allMessages = messages.getBySession(session.id)
      let summaryText: string
      let summaryKeywords: string[]
      try {
        const review = await summarize(
          allMessages.map((m) => ({ role: m.role, content: m.content })),
          client,
        )
        summaryText = review.summary
        summaryKeywords = review.keywords
        process.stderr.write(
          `[cli] summarize ok summary=${summaryText.length}c keywords=${summaryKeywords.length}\n`,
        )
      } catch (err) {
        process.stderr.write(`[cli] summarize failed: ${(err as Error).message}\n`)
        summaryText = '(summarization failed)'
        summaryKeywords = []
      }

      process.stderr.write(`[cli] markEnded ${session.id} reason=${exitReason}\n`)
      sessions.markEnded(session.id, {
        phaseHistory,
        summary: summaryText,
        keywords: summaryKeywords,
        reason: exitReason,
      })
      process.stderr.write('[cli] markEnded done\n')

      // v0.7.2 — embed the freshly written summary so the next session can
      // find this one via cross-session semantic retrieval. Runs AFTER
      // markEnded (the row already has summary populated). Skip the
      // placeholder. Failure here is best-effort: the summary itself is
      // saved; only the cross-session-lookup eligibility is lost (next
      // listWithEmbeddings filters NULL rows).
      if (summaryText && summaryText !== '(summarization failed)') {
        try {
          const summaryVec = await embedder.embed(summaryText)
          sessions.setEmbedding(session.id, summaryVec)
          process.stderr.write(
            `[cli] embedded session.summary (${summaryVec.length} dim, ${summaryVec.byteLength} bytes)\n`,
          )
        } catch (err) {
          process.stderr.write(`[cli] embed summary failed: ${(err as Error).message}\n`)
        }
      }

      // v0.6 — match summaryKeywords against the topic library; if a topic
      // hits, increment its stat row. Runs AFTER markEnded so a topic
      // failure can never block session persistence. If summarize failed
      // (summaryKeywords = []), matchTopic returns null and we skip.
      const match = matchTopic(summaryKeywords, topics.list())
      if (match) {
        topicStats.incrementAndUpdate(match.topic, new Date())
        process.stderr.write(
          `[cli] topic match: ${match.topic} jaccard=${match.jaccard.toFixed(2)} shared=[${match.shared.join(',')}]\n`,
        )
      } else {
        process.stderr.write(`[cli] topic match: none (keywords=[${summaryKeywords.join(',')}])\n`)
      }
    } finally {
      rl.close()
      db.close()
    }
  }
}

// Auto-run when this file is the entry point (e.g. `node --import tsx src/cli.ts`).
// When imported by other code (e.g. tests), only `main` is exported.
const isEntry = import.meta.url === pathToFileURL(process.argv[1] ?? '').href
if (isEntry) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
