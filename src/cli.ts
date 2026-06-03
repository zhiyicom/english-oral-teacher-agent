import { existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { type Interface, createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'
import { loadEnv } from './config/env.js'
import { createAnthropicProvider } from './llm/anthropic.js'
import { createReplayProvider } from './llm/testing.js'
import type { LLMClient, Message } from './llm/types.js'
import { type SystemPrompt, buildSystemString, loadSystemPrompt } from './prompts/loader.js'

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

function ask(rl: Interface, prompt: string): Promise<string> {
  return new Promise((resolveQ) => rl.question(prompt, resolveQ))
}

export async function main(): Promise<void> {
  const env = loadEnv()

  if (!existsSync(env.APP_DATA_DIR)) {
    mkdirSync(env.APP_DATA_DIR, { recursive: true })
  }

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

  printBanner(systemPrompt)

  try {
    while (true) {
      let raw: string
      try {
        raw = await ask(rl, '> ')
      } catch (err) {
        if (
          err instanceof Error &&
          (err.message.includes('closed') || err.message.includes('EOF'))
        ) {
          break
        }
        throw err
      }
      const input = raw.trim()
      if (input === '' || input.toLowerCase() === 'exit') break

      history.push({ role: 'user', content: input })

      process.stdout.write('[Teacher]: ')
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
    }
  } finally {
    rl.close()
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
