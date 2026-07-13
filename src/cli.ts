import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { type Interface, createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'
import {
  type Clock,
  type LastReview,
  type PhaseTransition,
  type SessionState,
  createMarkMistakeTool,
  createMemorySearchTool,
  createSummarizeHistoryTool,
  createToolRegistry,
  createTopicSelectTool,
  initState,
  loadLastReview,
  matchTopic,
  mockClock,
  realClock,
  recordAdoptedTopics,
  runTurn,
  summarize,
} from './agent/index.js'
import type { TurnEvent } from './agent/turn.js'
import type { AdoptedTopic } from './agent/topic-recorder.js'
import { loadEnv } from './config/env.js'
import { getAppDataDir, getReplayFixturesDir } from './config/paths.js'
import { isAutoExpandTopicsEnabled } from './config/preferences.js'
import { createAnthropicProvider } from './llm/anthropic.js'
import { logSummarizeFailure } from './llm/debug-log.js'
import { createOpenAIProvider } from './llm/openai.js'
import { createReplayProvider, createThrowingProvider } from './llm/testing.js'
import type { LLMClient, Message } from './llm/types.js'
import {
  type RelevantSession,
  createTransformersEmbedder,
  retrieveRelevant,
} from './memory/index.js'
import { extractStudentDiscoveries } from './agent/profile-extractor.js'
import { autoExpandTopicLibrary } from './agent/auto-expand.js'
import { type SystemPrompt, loadSystemPrompt } from './prompts/loader.js'
import {
  type Mistake,
  type TopicStat,
  applyMigrations,
  createKeywordHitsDao,
  createMessagesDao,
  createMistakesDao,
  createSessionsDao,
  createTopicStatsDao,
  createTopicsDao,
  openDb,
} from './storage/index.js'

function selectClient(env: ReturnType<typeof loadEnv>, _fixturesDir: string): LLMClient {
  // v0.7.6 (V751-002) — test-only path: if LLM_TEST_FAIL is set, return a
  // provider that throws an error with the configured HTTP status on every
  // call. Used by L3 tests to exercise the catch-all + auto-save path. Not
  // documented in .env.example (intentionally test-only).
  const testFail = process.env.LLM_TEST_FAIL
  if (testFail) {
    const status = Number.parseInt(testFail, 10)
    if (Number.isFinite(status)) {
      return createThrowingProvider(status, `LLM_TEST_FAIL=${status}`)
    }
  }
  // Always live.
  return process.env.API_STYLE?.trim() === 'openai'
    ? createOpenAIProvider(env)
    : createAnthropicProvider(env)
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

// v0.8.1 — STOP_REGEX and formatToolResult have moved to src/agent/turn.ts
// (the shared turn logic used by both the CLI REPL and the web server's
// SSE handler). The CLI no longer needs them directly; it just calls
// runTurn() and forwards the resulting events to stderr. See
// docs/sprint/v0.8-design.md §5 for the refactor design.

// v0.8.1 — forward a TurnEvent to stderr (observability) or stdout
// (student-facing text). Preserves the exact v0.7.7 log format so L3 tests
// in tests/agent/cli-integration.test.ts continue to pass unchanged.
// The `warnedRef` parameter is mutated to enforce once-per-session warn.
function forwardEvent(event: TurnEvent, warnedRef: { value: boolean }): void {
  switch (event.type) {
    case 'phase': {
      if (event.reason === 'phase_end') {
        process.stderr.write('[cli] session ended (time-based, 30 min reached)\n')
      } else if (event.reason === 'user_stop') {
        process.stderr.write(
          `[cli] phase → END (user_stop, elapsed=${event.elapsed.toFixed(1)} min)\n`,
        )
      } else {
        process.stderr.write(
          `[cli] phase → ${event.phase} (elapsed=${event.elapsed.toFixed(1)} min)\n`,
        )
      }
      break
    }
    case 'ctx':
      process.stderr.write(
        `[cli] ctx: ${event.phase} elapsed=${event.elapsed.toFixed(1)} silence=${event.silence.toFixed(1)}\n`,
      )
      break
    case 'ctx-segment':
      process.stderr.write(
        `[cli] ctx-segment: phase=${event.phase} last=${event.last} relevant=${event.relevant} active=${event.active} mistakes=${event.mistakes}\n`,
      )
      break
    case 'ctx-block':
      process.stderr.write(`[cli] ctx-block:\n${event.dynamic}\n`)
      break
    case 'truncated':
      process.stderr.write(
        `[cli] truncated: dropped ${event.dropped} pairs, history now ${event.newLength} messages (est ${event.estAfter} tokens)\n`,
      )
      break
    case 'tokens':
      process.stderr.write(
        `[cli] tokens: input=${event.input} output=${event.output} cache_read=${event.cacheRead} cache_creation=${event.cacheCreation}\n`,
      )
      break
    case 'warn':
      if (!warnedRef.value) {
        process.stderr.write(`[cli] warn: context usage ${event.pct}% (budget=${event.budget})\n`)
        warnedRef.value = true
      }
      break
    case 'tool-call':
      process.stderr.write(`[cli] tool call: ${event.name}(${JSON.stringify(event.args)})\n`)
      break
    case 'tool-2nd-call':
      process.stderr.write(`[cli] tool 2nd-call: ${event.name}(${event.argSummary})\n`)
      break
    case 'tool-dedup':
      process.stderr.write(`[cli] tool dedup: skipped (already marked: "${event.original}")\n`)
      break
    case 'tool-unknown':
      process.stderr.write(`[cli] tool unknown: ${event.name}\n`)
      break
    case 'tool-execute-error':
      process.stderr.write(`[cli] tool execute error: ${event.message}\n`)
      break
    case 'tool-parse-error':
      process.stderr.write(`[cli] tool parse error: ${event.message}\n`)
      break
    case 'tool-summarize-result':
      if (event.compressed !== null) {
        process.stderr.write(
          `[cli] tool summarize: compressed ${event.compressed} → 1 message (target=${event.targetTokens}t)\n`,
        )
      } else {
        process.stderr.write(
          `[cli] tool summarize: skipped (history too short: ${event.historyLength} msgs)\n`,
        )
      }
      break
    case 'error':
      if (event.classification === 'persistent_llm_failure') {
        process.stderr.write('[cli] persistent llm failure; falling back\n')
      } else if (event.classification === 'summarize_failed') {
        process.stderr.write(`[cli] tool summarize error: ${event.message}\n`)
      } else {
        process.stderr.write(`[cli] error (${event.classification}): ${event.message}\n`)
      }
      break
    case 'session-auto-saved':
      process.stderr.write(`[cli] session auto-saved: ${event.sessionId}\n`)
      break
    case 'text-chunk':
      // v0.8.5 — real-time per-token output to stdout
      process.stdout.write(event.delta)
      break
    case 'student-text':
      process.stdout.write(event.text)
      break
    case 'done':
      // No stderr log; loop applies endedReason from TurnOutput.
      break
  }
}

export async function main(): Promise<void> {
  const env = loadEnv()
  const clock = selectClock()
  const mockTime = process.env.MOCK_TIME === '1'

  // Open SQLite + run migrations + create session row
  const db = openDb({ dataDir: getAppDataDir() })
  applyMigrations(db)
  const sessions = createSessionsDao(db)
  const messages = createMessagesDao(db)
  const topics = createTopicsDao(db)
  const topicStats = createTopicStatsDao(db)
  const keywordHits = createKeywordHitsDao(db)
  const session = sessions.create()
  // v1.1.0 §1.1 — read the auto-expand toggle at startup. CLI is a
  // single-process session so a per-run snapshot is sufficient; runtime
  // edits via Web UI don't propagate to a CLI session in flight.
  const autoExpandEnabled = isAutoExpandTopicsEnabled(getAppDataDir())

  const systemPrompt = loadSystemPrompt()

  const fixturesDir = getReplayFixturesDir()
  const client = selectClient(env, fixturesDir)

  const history: Message[] = []
  const phaseHistory: PhaseTransition[] = []
  let state: SessionState = initState(clock.now())
  phaseHistory.push({ phase: state.phase, at: 0, reason: 'time' })
  let exitReason: 'user_exit' | 'user_stop' | 'phase_end' = 'user_exit'
  // v1.0.7 §11 — in-memory ledger of topics locked in for this session.
  // Mutated by runTurn via Hook A (MAIN_ACTIVITY auto-inject) and Hook B
  // (LLM topic_select success). Read by the END pipeline below to drive
  // topic_stats / keyword_hits writes.
  // v1.0.7 §11 — see server.ts. v1.0.9 §1.4 added the new fields.
const adoptedTopics: Map<string, AdoptedTopic> = new Map()
  // v0.7.5 — 80%-budget warn fires once per session, not every turn (see
  // v0.7.5-scope.md §6 risk #5). Reset implicitly per process start, so a
  // fresh CLI invocation gets a fresh warn window.
  // v0.8.1 — wrapped in a ref object so `forwardEvent()` (declared below
  // outside the loop) can mutate it without closure capture issues.
  const warnedRef = { value: false }

  // v1.0.3 §1.3 — module-scoped WARM_UP opener hook. Written by the
  // session-end profile-extract of THIS process's previous invocation
  // (in-memory only — process restart resets to null, which is fine:
  // WARM_UP hint gracefully falls back to "natural connection" text).
  // Single-user system so a global is sufficient.
  let pendingWarmUpSeed: string | null = null

  // v0.5 — load the most recent session's summary for [System Context] injection.
  // Injected only on the FIRST turn of this session (first-turn-only per v0.5 design §2.5).
  const lastReview: LastReview | null = loadLastReview(db)
  let isFirstTurn = true
  // v1.0.3 §1.3 — read & clear the WARM_UP opener hook from the previous
  // session-end. Mirrors server.ts: POST /api/sessions semantics.
  const warmUpHook = pendingWarmUpSeed
  pendingWarmUpSeed = null

  // v0.6 — load aggregated topic_stats once at startup. Unlike lastReview
  // (per-session retrospective, first-turn-only), active topics are a
  // cross-session aggregate that stays useful for the WHOLE session, so we
  // pass the same list to every turn. Re-read each turn is unnecessary:
  // topic_stats is only mutated in the finally block of THIS process, after
  // the loop ends, so within-session reading once is correct.
  //
  // v1.0.9 §1.1 — switch the tool to getter form anyway so Server / CLI
  // share the same code path. Within a single CLI invocation the getter
  // just re-reads the same row data, so there's no behavioral change.
  const activeTopics: TopicStat[] = topicStats.all()

  // v0.7 — register tools. mark_mistake is bound to this session's id so the
  // LLM never has to pass sessionId (and can't cross sessions by accident).
  // v0.7.3 — memory_search is bound to the (already-instantiated) embedder
  // and DB. It uses the A+B hybrid protocol (LLM emits a text tool block,
  // CLI executes + feeds result back as a synthetic user message, then makes
  // a 2nd LLM call). See v0.7.3-design.md §2.
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

  // v0.7.6 — V751-002: chatStream error handling. Set by the catch-all
  // around chatStreamWithRetry() in the main loop when the LLM fails
  // persistently. The `finally` block checks this flag to skip its
  // normal summarize+markEnded+embed+topic-match (the catch-all already
  // did its own auto-save with a placeholder summary).
  let sessionPersisted = false

  // v0.7.2 — semantic retrieval of relevant past sessions. Seeded by the
  // previous session's keywords (lastReview), excluding lastReview itself
  // (already injected by the "Last session" segment). The embedder is lazy:
  // the transformers.js pipeline only loads on the first embed() call, so
  // creating the instance here is essentially free. Skip retrieval if there
  // is no lastReview or no keywords to seed the query. Failures degrade
  // gracefully to an empty result — the CLI never blocks on this.
  const embedder = createTransformersEmbedder()
  // Register memory_search now that the embedder singleton exists. Note: the
  // first memory_search execute() will be the first user-facing call that
  // actually triggers the model load — startup retrieval above only embeds
  // short keyword strings, but the same embedder instance is reused, so the
  // pipeline is already hot by the time the LLM calls this tool.
  toolRegistry.register(createMemorySearchTool(db, embedder))
  // v0.7.6 B2 — summarize_history is a marker tool: it has no DB / embedder
  // dependencies because the actual history rewrite happens in the CLI's
  // main loop (where `history` lives). The tool just validates args and
  // returns a typed signal so the CLI knows to invoke the summarizer.
  toolRegistry.register(createSummarizeHistoryTool())
  // v0.7.6 D5 — topic_select. Pure compute: receives the topic library +
  // stats at registration time. The tool returns a typed result that the
  // CLI feeds back to the LLM via the 2nd-call A+B path (no history rewrite,
  // just a follow-up LLM call). Interests are empty for now — the persona
  // doesn't load a separate interest list, and D3 still works (returns 0
  // overlap, no boost applied). v0.8+ can wire real interests from USER.md.
  toolRegistry.register(
    createTopicSelectTool({
      topics: topics.list(),
      // v1.0.9 §1.1 — getters (same as server.ts). Within one CLI
      // invocation the getter just re-reads the same row data; the
      // change keeps Server / CLI on the same code path.
      stats: () => topicStats.all(),
      interests: [],
      keywordStats: () => keywordHits.getAll(),
      // v1.0.3 §1.3 — D3 (interest boost) disabled. WARM_UP phase prompt
      // handles interest matching; this tool only sees call-count signals.
      useInterestBoost: false,
    }),
  )
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

  // v0.7.6 B1 — anchor pair. Captures the first user/assistant exchange of
  // this session so the truncate-history sliding window can protect it from
  // being dropped. Populated AFTER the first LLM response is processed
  // (turn 1 → turn 2 boundary). See v0.7.6-design.md §3.2.
  const firstPair: Message[] = []

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
      const userInput = raw.trim()
      if (userInput === '' || userInput.toLowerCase() === 'exit') break

      // Pre-check time-based END before bothering runTurn (so the
      // "session ended (time-based)" log still fires at the CLI layer).
      // runTurn also handles this, but the CLI uses a different log line
      // for time-based END that L3 tests are not strict about.
      reader.writePrompt('[Teacher]: ')

      const turnIter = runTurn(
        {
          sessionId: session.id,
          userInput,
          state,
          history,
          phaseHistory,
          firstPair,
          relevantPast,
          activeTopics,
          recentMistakes,
          lastReview,
          isFirstTurn,
          systemPrompt,
          // v1.0.3 §1.3 — WARM_UP opener hook read at startup above.
          warmUpHook,
          // v1.0.7 §11 — pass the session's adopted-topics ledger so runTurn
          // can append slugs as they're locked in.
          adoptedTopics,
          mockTime,
        },
        {
          env: { LLM_CONTEXT_BUDGET_TOKENS: env.LLM_CONTEXT_BUDGET_TOKENS },
          clock,
          client,
          embedder,
          toolRegistry,
          sessions,
          messages,
          topicStats,
          markedOriginals,
        },
      )

      // Drain events until runTurn returns. Forward each event to stderr
      // (observability for L3 tests) or stdout (student-facing text).
      // The AsyncGenerator's return value (TurnOutput) is on the `done: true`
      // result — we capture it for the post-turn state update.
      let output: Awaited<ReturnType<typeof turnIter.next>>['value'] = undefined as never
      while (true) {
        const next = await turnIter.next()
        if (next.done) {
          output = next.value
          break
        }
        forwardEvent(next.value, warnedRef)
      }
      // After turn completes, apply state changes back to the local refs.
      // (history/phaseHistory/firstPair are mutated in-place inside runTurn,
      // so we don't need to copy them — but state and isFirstTurn are
      // returned by value.)
      if (output) {
        state = output.state
        isFirstTurn = output.isFirstTurn
        if (output.sessionPersisted) sessionPersisted = true
        if (output.endedReason === 'llm_error') {
          process.exitCode = 1
          break
        }
        if (output.endedReason === 'phase_end' || output.endedReason === 'user_stop') {
          exitReason = output.endedReason
          break
        }
      }
    }
  } finally {
    // Persist the session as ended and close the DB regardless of how we exit.
    try {
      // v0.7.6 (V751-002) — if the catch-all around chatStreamWithRetry()
      // already persisted the session, skip the normal pipeline. The
      // catch-all uses a placeholder summary when the LLM is broken, and
      // re-running summarize() here would just retry the same failing call.
      if (sessionPersisted) {
        process.stderr.write('[cli] persistence skipped (handled by V751-002 catch-all)\n')
      } else {
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
          // v1.0.6 hotfix — also write a structured failure record to
          // data/llm-debug/ so the next silent failure is diagnosable
          // without depending on the stderr stream being captured.
          logSummarizeFailure(session.id, allMessages.length, exitReason, err)
          summaryText = '(summarization failed)'
          summaryKeywords = []
        }

        // v1.0.7 §11 — write-on-selection. Record adopted topics (or fall back
        // to summary-keyword match) BEFORE markEnded so topicsUsed can land
        // in `sessions.topics_used` atomically with the rest of the row.
        let topicsUsed: string[] = []
        try {
          topicsUsed = recordAdoptedTopics(
            adoptedTopics,
            summaryKeywords,
            { sessionId: session.id, now: new Date() },
            { topics: topics.list(), topicStats, keywordHits, topicsDao: topics },
          )
          process.stderr.write(
            `[cli] topics recorded: [${topicsUsed.join(',')}] (adopted=${adoptedTopics.size}, fallback=${adoptedTopics.size === 0})\n`,
          )
        } catch (err) {
          process.stderr.write(`[cli] topic record failed: ${(err as Error).message}\n`)
        }

        // v1.1.0 §1.3 — auto-expand topic library (opt-in via preferences.json).
        // Same try/catch envelope as recordAdoptedTopics: best-effort, doesn't
        // block markEnded. Reads the toggle once at startup (CLI is single-
        // process per session).
        try {
          await autoExpandTopicLibrary(
            summaryKeywords,
            topicsUsed,
            { topics: topics.list(), topicStats, keywordHits, topicsDao: topics, client },
            { now: new Date() },
            { enabled: autoExpandEnabled },
          )
        } catch (err) {
          process.stderr.write(`[cli] auto-expand failed: ${(err as Error).message}\n`)
        }

        process.stderr.write(`[cli] markEnded ${session.id} reason=${exitReason}\n`)
        sessions.markEnded(session.id, {
          phaseHistory,
          summary: summaryText,
          keywords: summaryKeywords,
          reason: exitReason,
          topicsUsed,
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

        // v1.0.3 §1.3 — extend the session-end pipeline with profile-extract
        // for parity with server.ts. Picks `nextWarmUpSeed` (single social-
        // opener keyword for the NEXT session's WARM_UP) and writes it to
        // the module-scoped cache. Skipped on summarization failure (no
        // meaningful summary to extract from).
        if (summaryText && summaryText !== '(summarization failed)') {
          try {
            const discoveries = await extractStudentDiscoveries(
              summaryText,
              systemPrompt.userProfile.interests,
              client,
            )
            pendingWarmUpSeed = discoveries.nextWarmUpSeed
            process.stderr.write(
              `[cli] WARM_UP seed picked: ${discoveries.nextWarmUpSeed ?? '(none)'}\n`,
            )
          } catch (err) {
            process.stderr.write(`[cli] profile-extract failed: ${(err as Error).message}\n`)
          }
        }
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
