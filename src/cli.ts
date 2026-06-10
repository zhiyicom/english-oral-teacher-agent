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
  buildFinalSystemSplit,
  createMarkMistakeTool,
  createMemorySearchTool,
  createToolRegistry,
  estimateMessagesTokens,
  estimateTokens,
  initState,
  loadLastReview,
  matchTopic,
  mockClock,
  parseToolCall,
  realClock,
  stripToolCall,
  summarize,
  truncateHistory,
} from './agent/index.js'
import { loadEnv } from './config/env.js'
import { createAnthropicProvider } from './llm/anthropic.js'
import { chatStreamWithRetry } from './llm/retry.js'
import { createReplayProvider, createThrowingProvider } from './llm/testing.js'
import type { LLMClient, Message, SystemBlock, UsageChunk } from './llm/types.js'
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

// v0.7.3 — format a memory_search result as a human-readable block that
// gets pushed back to the LLM as a synthetic user message (so the 2nd
// LLM call can answer the student using this context). Keep it compact
// and structured — the LLM parses it, the student never sees it.
//
// Marker note: the prefix `[tool_result_v073]` is a unique substring used
// as the fixture match key for the 2nd-call Replay fixture. The
// retrieved session summary (and keywords) can contain any natural-
// language word, so a more specific tag like `[v073_followup_responder]`
// is added on the first line to guarantee the Replay matcher only sees
// the 2nd-call fixture. The marker is safe for the LLM to see (it's a
// structural signal, like system prefixes).
function formatToolResult(name: string, result: unknown): string {
  if (name !== 'memory_search') {
    return `[tool_result_v073]\n[v073_followup_responder]\n[Tool result: ${name}]\n${JSON.stringify(result)}`
  }
  const sessions = result as RelevantSession[]
  if (!Array.isArray(sessions) || sessions.length === 0) {
    return '[tool_result_v073]\n[v073_followup_responder]\n[Tool result: memory_search]\nNo relevant past sessions found.'
  }
  const lines = sessions.map((s, i) => {
    const summary = s.summary.length > 80 ? `${s.summary.slice(0, 80)}...` : s.summary
    return `${i + 1}. ${s.daysAgo} day${s.daysAgo === 1 ? '' : 's'} ago: "${summary}" (keywords: ${s.keywords.join(', ')})`
  })
  return `[tool_result_v073]\n[v073_followup_responder]\n[Tool result: memory_search]\nTop ${sessions.length} most relevant past session${sessions.length === 1 ? '' : 's'}:\n${lines.join('\n')}`
}

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
  // v0.7.5 — 80%-budget warn fires once per session, not every turn (see
  // v0.7.5-scope.md §6 risk #5). Reset implicitly per process start, so a
  // fresh CLI invocation gets a fresh warn window.
  let warned = false

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

      // After the first system build, freeze the last-review / relevantPast
      // injection — subsequent turns build the system string from a fresh
      // state but without the review (which would otherwise drift / look
      // stale 25 min in).
      const wasFirstTurn = isFirstTurn
      isFirstTurn = false

      // v0.7.5 — build the system prompt as two segments so Anthropic can
      // cache the static portion (SOUL + AGENTS + USER) across turns. We
      // build it ONCE per turn and reuse the same `systemBlocks` for the
      // 2nd call in the A+B memory_search path (no state change between
      // 1st and 2nd call within one turn).
      const sysSeg = buildFinalSystemSplit(
        systemPrompt,
        state,
        wasFirstTurn ? lastReview : null,
        activeTopics,
        recentMistakes,
        wasFirstTurn ? relevantPast : [],
      )
      const systemSize = estimateTokens(sysSeg.static) + estimateTokens(sysSeg.dynamic)

      // v0.7.5 — sliding-window truncate history by estimated total input
      // (system + messages). The estimator (chars/4) is conservative for
      // English + Chinese mixed; post-call SDK usage validates the real
      // number. Drops oldest user/assistant pairs; always keeps the most
      // recent pair (the loop's invariant — see truncate-history.ts).
      // v0.7.6 B1 — also pass the captured firstPair (first user/assistant
      // exchange of this session) as `anchorPair`. truncate-history preserves
      // the anchor verbatim and only truncates the droppable middle/older
      // portion. This protects the WARM_UP topic intro from being dropped
      // as the session grows long. See v0.7.6-design.md §3.2.
      const { messages: truncMsgs, dropped } = truncateHistory(
        history,
        env.LLM_CONTEXT_BUDGET_TOKENS,
        { systemSize, anchorPair: firstPair },
      )
      if (dropped > 0) {
        const estAfter = estimateMessagesTokens(truncMsgs) + systemSize
        process.stderr.write(
          `[cli] truncated: dropped ${dropped} pairs, history now ${truncMsgs.length} messages (est ${estAfter} tokens)\n`,
        )
        history.length = 0
        history.push(...truncMsgs)
      }

      const systemBlocks: SystemBlock[] = [
        { type: 'text', text: sysSeg.static, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: sysSeg.dynamic },
      ]

      // Surface the [System Context] block on stderr so L3 tests can verify
      // what phase the LLM sees (and so users can debug phase behavior live).
      process.stderr.write(
        `[cli] ctx: ${state.phase} elapsed=${state.elapsedMin.toFixed(1)} silence=${state.silenceMin.toFixed(1)}\n`,
      )
      // v0.7.2 — dump the full rendered [System Context] block on the FIRST
      // turn (the [cli] ctx line above covers the per-turn summary; this
      // dump shows the actual segment content). First-turn-only because the
      // lastReview/relevantPast injection is first-turn-only too — would be
      // identical on later turns and would just spam stderr.
      if (wasFirstTurn) {
        process.stderr.write(`[cli] ctx-block:\n[System Context]${sysSeg.dynamic}\n`)
      }
      reader.writePrompt('[Teacher]: ')
      // v0.7 — buffer the full response BEFORE writing to stdout. We need to
      // strip any <tool>...</tool> block before the student sees it (the
      // tool block is an internal CLI signal, not student-facing text).
      // v0.7.5 — also capture the usage chunk (yielded once at start of
      // stream, mirroring Anthropic's message_start.usage event) for the
      // post-call token log + 80% warn. The Replay provider doesn't emit
      // usage chunks, so this is silent under L3 tests.
      // v0.7.6 — wrap the stream in chatStreamWithRetry (1x retry on
      // retryable errors per V751-002). On persistent failure, fall back
      // to a friendly message + auto-save the session so the next session
      // has at least the transcript context. See v0.7.6-design.md §3.1.
      let response = ''
      let usage: UsageChunk | null = null
      try {
        const streamResult = await chatStreamWithRetry(client, {
          systemBlocks,
          messages: history,
        })
        response = streamResult.response
        usage = streamResult.usage
      } catch (_err) {
        // Persistent LLM failure — graceful degradation. The student sees
        // a friendly fallback message; the session is auto-saved with a
        // placeholder summary so the next session retains the transcript
        // context (if it can be summarized) and the session row is
        // properly marked ended (reason: current exitReason).
        process.stderr.write('[cli] persistent llm failure; falling back\n')
        process.stdout.write(
          '\n[Teacher]: Sorry, I lost my train of thought. Could you say that again? 😊\n\n',
        )
        const allMessages = messages.getBySession(session.id)
        let summaryText = '(summarization failed after llm error)'
        let summaryKeywords: string[] = []
        try {
          const review = await summarize(
            allMessages.map((m) => ({ role: m.role, content: m.content })),
            client,
          )
          summaryText = review.summary
          summaryKeywords = review.keywords
        } catch {
          // LLM is broken — keep the placeholder already in summaryText.
        }
        sessions.markEnded(session.id, {
          phaseHistory,
          summary: summaryText,
          keywords: summaryKeywords,
          reason: exitReason,
        })
        sessionPersisted = true
        process.stderr.write(`[cli] session auto-saved: ${session.id}\n`)
        process.exitCode = 1
        break
      }

      // v0.7.5 — log actual token usage after each LLM call. Silent under
      // Replay fixtures (no usage chunk emitted). With RUN_LIVE_LLM=1 the
      // Anthropic provider yields the real message_start.usage event.
      // v0.7.5.1 (V751-001 fix) — the 80% warn uses the TOTAL context the
      // LLM actually sees: `inputTokens + cacheReadTokens + cacheCreationTokens`.
      // Anthropic's `input_tokens` is the FRESH count (cached portion reported
      // separately). With cache_control: ephemeral in effect, fresh stays
      // small (~30-700) but the cached static portion (~1800-2400) still
      // counts against the LLM's context window. Checking fresh alone would
      // make the warn never fire under caching — see v0.7.5-validation-report.md
      // §scenario-1 analysis.
      if (usage) {
        process.stderr.write(
          `[cli] tokens: input=${usage.inputTokens} output=${usage.outputTokens} cache_read=${usage.cacheReadTokens} cache_creation=${usage.cacheCreationTokens}\n`,
        )
        // 80% warn — fires at most once per session (per v0.7.5-scope §6
        // risk #5). The guard `env.LLM_CONTEXT_BUDGET_TOKENS > 0` is
        // defensive; zod already enforces min(1).
        const totalInput = usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens
        if (
          !warned &&
          env.LLM_CONTEXT_BUDGET_TOKENS > 0 &&
          totalInput / env.LLM_CONTEXT_BUDGET_TOKENS >= 0.8
        ) {
          const pct = Math.round((totalInput / env.LLM_CONTEXT_BUDGET_TOKENS) * 100)
          process.stderr.write(
            `[cli] warn: context usage ${pct}% (budget=${env.LLM_CONTEXT_BUDGET_TOKENS})\n`,
          )
          warned = true
        }
      }

      // v0.7 — parse the tool block. v0.7.3 — dispatch into 4 branches:
      //   no tool            → stdout the LLM text as-is
      //   mark_mistake       → sync side-effect, v0.7 path unchanged
      //   memory_search      → A+B hybrid: execute, feed result to LLM, 2nd call
      //   unknown / errored  → strip the block, log, treat as no-tool
      // Tool failures (parse/schema/execute) are logged to stderr and
      // skipped; they never block the conversation. mark_mistake and
      // memory_search are best-effort.
      let display = response
      let parsed: ReturnType<typeof parseToolCall> = null
      try {
        parsed = parseToolCall(response)
      } catch (err) {
        process.stderr.write(`[cli] tool parse error: ${(err as Error).message}\n`)
      }

      if (!parsed) {
        // No tool: stdout the LLM text as-is (v0.7 path).
        process.stdout.write(`${display}\n\n`)
        history.push({ role: 'assistant', content: display })
        messages.append({ sessionId: session.id, role: 'assistant', content: display })
      } else if (parsed.name === 'mark_mistake') {
        // Sync side-effect tool. Strip the tool block, execute, log.
        display = stripToolCall(response, parsed)
        const original = typeof parsed.args.original === 'string' ? parsed.args.original : ''
        if (original && markedOriginals.has(original)) {
          process.stderr.write(`[cli] tool dedup: skipped (already marked: "${original}")\n`)
        } else {
          try {
            const tool = toolRegistry.get(parsed.name)
            if (!tool) {
              process.stderr.write(`[cli] tool unknown: ${parsed.name}\n`)
            } else {
              tool.execute(parsed.args)
              if (original) markedOriginals.add(original)
              process.stderr.write(
                `[cli] tool call: ${parsed.name}(${JSON.stringify(parsed.args)})\n`,
              )
            }
          } catch (err) {
            process.stderr.write(`[cli] tool execute error: ${(err as Error).message}\n`)
          }
        }
        process.stdout.write(`${display}\n\n`)
        history.push({ role: 'assistant', content: display })
        messages.append({ sessionId: session.id, role: 'assistant', content: display })
      } else if (parsed.name === 'memory_search') {
        // A+B hybrid: execute, push result as synthetic user message, 2nd
        // LLM call, use 2nd response as the final student-facing text.
        // The first response (with the tool block intact) goes into history
        // verbatim — the 2nd-call LLM needs to see what it just did.
        // We DO NOT strip the tool block from history (the LLM must see it
        // for context), but we also don't echo it to stdout or messages.
        const tool = toolRegistry.get(parsed.name)
        if (!tool) {
          process.stderr.write(`[cli] tool unknown: ${parsed.name}\n`)
          // Fall through to the unknown-tool path below: strip + display.
          display = stripToolCall(response, parsed)
          process.stdout.write(`${display}\n\n`)
          history.push({ role: 'assistant', content: display })
          messages.append({ sessionId: session.id, role: 'assistant', content: display })
        } else {
          process.stderr.write(`[cli] tool call: ${parsed.name}(${JSON.stringify(parsed.args)})\n`)
          let result: unknown
          try {
            result = await tool.execute(parsed.args)
          } catch (err) {
            process.stderr.write(`[cli] tool execute error: ${(err as Error).message}\n`)
            result = []
          }
          // Build history for the 2nd call: keep the original 1st-call
          // assistant message (with the tool block), then push a synthetic
          // user message containing the formatted result. The [tool_result_v073]
          // marker is the fixture match key for the 2nd Replay fixture.
          history.push({ role: 'assistant', content: response })
          const resultText = formatToolResult(parsed.name, result)
          history.push({ role: 'user', content: resultText })
          // 2nd LLM call (non-streaming — simpler; matches how summarize()
          // calls chat). If the 2nd-call response accidentally contains a
          // tool block, strip it as a safety net (don't recurse).
          // v0.7.5 — reuse the same systemBlocks (state hasn't changed
          // mid-turn; cache_control on the static prefix still applies).
          const followup = await client.chat({ systemBlocks, messages: history })
          // Log the 2nd-call as observability: a topK/argCount summary is
          // enough — we don't dump the full result text to stderr.
          const argSummary =
            typeof parsed.args.top_k === 'number' ? `top_k=${parsed.args.top_k}` : ''
          process.stderr.write(`[cli] tool 2nd-call: ${parsed.name}(${argSummary})\n`)
          // Safety strip: if 2nd-call LLM emitted another <tool> block, drop it.
          // (Prompt tells it not to, and cli.ts only does 1 round-trip per
          // turn, so this is purely cosmetic — but it prevents tool-block
          // leakage into the student's stdout.)
          let followupDisplay = followup.content
          const followupParsed = (() => {
            try {
              return parseToolCall(followup.content)
            } catch {
              return null
            }
          })()
          if (followupParsed) {
            followupDisplay = stripToolCall(followup.content, followupParsed)
          }
          process.stdout.write(`${followupDisplay}\n\n`)
          history.push({ role: 'assistant', content: followupDisplay })
          messages.append({ sessionId: session.id, role: 'assistant', content: followupDisplay })
        }
      } else {
        // Unknown tool name: strip the block, log, treat as no-tool output.
        display = stripToolCall(response, parsed)
        process.stderr.write(`[cli] tool unknown: ${parsed.name}\n`)
        process.stdout.write(`${display}\n\n`)
        history.push({ role: 'assistant', content: display })
        messages.append({ sessionId: session.id, role: 'assistant', content: display })
      }

      // v0.7.6 B1 — capture the first user/assistant pair of this session
      // so truncateHistory can protect it from being dropped (anchor pair).
      // Captured AFTER the assistant message is pushed (turn 1). Runs once
      // per session because `firstPair.length === 0` gates subsequent calls.
      // Safe across all 4 tool branches: at this point history[0..1] is
      // the user's first input + the assistant's first response (or its
      // tool-stripped variant for mark_mistake / unknown paths; the
      // memory_search A+B path also has the original 1st-call response
      // in history by line 502).
      if (firstPair.length === 0 && history.length >= 2) {
        const first = history[0]
        const second = history[1]
        if (first && second) {
          firstPair.push(first, second)
        }
      }

      // MOCK_TIME: advance the fake clock by 1 min per turn so the
      // state machine sees time progress without real waiting.
      if (mockTime && clock !== realClock) {
        ;(clock as ReturnType<typeof mockClock>).advance(60_000)
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
          process.stderr.write(
            `[cli] topic match: none (keywords=[${summaryKeywords.join(',')}])\n`,
          )
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
