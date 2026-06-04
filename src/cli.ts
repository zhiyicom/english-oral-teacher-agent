import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { type Interface, createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'
import { loadEnv } from './config/env.js'
import { createAnthropicProvider } from './llm/anthropic.js'
import { createReplayProvider } from './llm/testing.js'
import type { LLMClient, Message } from './llm/types.js'
import { type SystemPrompt, buildSystemString, loadSystemPrompt } from './prompts/loader.js'
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

function printBanner(sp: SystemPrompt): void {
  const profile = sp.userProfile
  console.log('English Oral Teacher Agent — CLI mode')
  console.log(`Persona target: ${profile.name} (age ${profile.age}, ${profile.level})`)
  console.log('Type "exit" to quit.\n')
}

// Buffered line reader.
//
// We can't use rl.question() directly because it has two problems for our loop:
//   1. rl.question() does not reject when stdin ends — its callback just
//      never fires, so a naive `await rl.question(...)` hangs forever on EOF.
//   2. readline 'line' events fire the moment a newline is read, regardless
//      of whether anyone is listening. If the LLM call is slow and the user
//      pastes multiple lines (or our test driver writes them faster than we
//      consume), every 'line' event fired during the LLM call is lost — we
//      only see the first line emitted *after* the LLM returns. Live LLM
//      verification exposed this: turns 2 and 3 vanished, and the next line
//      read was the one that arrived just as the LLM finished.
//
// The fix is to listen for 'line' and 'close' events ONCE, immediately, and
// push lines into a queue. ask() returns synchronously from the queue when
// one is available, and otherwise waits on a single resolver.
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
      w('') // signal EOF to the loop
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
      // Just a visual cue — we don't use rl.question because the actual line
      // is delivered via the 'line' event listener above.
      process.stdout.write(prompt)
    },
  }
}

export async function main(): Promise<void> {
  const env = loadEnv()

  // Open SQLite + run migrations + create session row
  const db = openDb({ dataDir: env.APP_DATA_DIR })
  applyMigrations(db)
  const sessions = createSessionsDao(db)
  const messages = createMessagesDao(db)
  const session = sessions.create()

  const systemPrompt = loadSystemPrompt()
  const systemString = buildSystemString(systemPrompt)

  const fixturesDir = resolve('tests/fixtures/replay')
  const client = selectClient(env, fixturesDir)

  const history: Message[] = []

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
      // createLineReader resolves with '' on stdin close (EOF). An empty
      // trimmed input is also our break signal (user just hit Enter).
      if (raw === '') break
      const input = raw.trim()
      if (input === '' || input.toLowerCase() === 'exit') break

      history.push({ role: 'user', content: input })
      messages.append({ sessionId: session.id, role: 'user', content: input })

      reader.writePrompt('[Teacher]: ')
      let response = ''
      for await (const chunk of client.chatStream({
        system: systemString,
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
    }
  } finally {
    // Persist the session as ended and close the DB regardless of how we exit.
    try {
      process.stderr.write(`[cli] markEnded ${session.id}\n`)
      sessions.markEnded(session.id)
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
