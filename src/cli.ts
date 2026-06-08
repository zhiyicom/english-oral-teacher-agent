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
  initState,
  loadLastReview,
  mockClock,
  realClock,
  summarize,
} from './agent/index.js'
import { loadEnv } from './config/env.js'
import { createAnthropicProvider } from './llm/anthropic.js'
import { createReplayProvider } from './llm/testing.js'
import type { LLMClient, Message } from './llm/types.js'
import { type SystemPrompt, loadSystemPrompt } from './prompts/loader.js'
import { applyMigrations, createMessagesDao, createSessionsDao, openDb } from './storage/index.js'

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

      const system = buildFinalSystem(systemPrompt, state, isFirstTurn ? lastReview : null)
      // After the first buildFinalSystem call, freeze the last-review injection —
      // subsequent turns build the system string from a fresh state but without
      // the review (which would otherwise drift / look stale 25 min in).
      isFirstTurn = false
      // Surface the [System Context] block on stderr so L3 tests can verify
      // what phase the LLM sees (and so users can debug phase behavior live).
      process.stderr.write(
        `[cli] ctx: ${state.phase} elapsed=${state.elapsedMin.toFixed(1)} silence=${state.silenceMin.toFixed(1)}\n`,
      )
      reader.writePrompt('[Teacher]: ')
      let response = ''
      for await (const chunk of client.chatStream({
        system,
        messages: history,
      })) {
        if (chunk.type === 'text') {
          process.stdout.write(chunk.delta)
          response += chunk.delta
        }
      }
      process.stdout.write('\n\n')
      history.push({ role: 'assistant', content: response })
      messages.append({ sessionId: session.id, role: 'assistant', content: response })

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
