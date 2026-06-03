import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatChunk, ChatOpts, ChatResult, LLMClient } from './types.js'

interface FixtureMatch {
  userSaysContains?: string
}

interface Fixture {
  name: string
  match?: FixtureMatch
  chunks: ChatChunk[]
  result: { content: string; thinking?: string }
}

function loadFixtures(dir: string): Fixture[] {
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'))
  return files.map((f) => {
    const raw = readFileSync(join(dir, f), 'utf-8')
    return JSON.parse(raw) as Fixture
  })
}

function pickFixture(fixtures: Fixture[], lastUserMessage: string): Fixture {
  for (const fx of fixtures) {
    const needle = fx.match?.userSaysContains
    if (!needle) continue
    if (lastUserMessage.toLowerCase().includes(needle.toLowerCase())) {
      return fx
    }
  }
  throw new Error(
    `No fixture matches user message: "${lastUserMessage}". Add a fixture to the replay directory or adjust the input.`,
  )
}

export function createReplayProvider(fixturesDir: string): LLMClient {
  const fixtures = loadFixtures(fixturesDir)

  async function* chatStream(opts: ChatOpts): AsyncIterable<ChatChunk> {
    const last = opts.messages[opts.messages.length - 1]
    if (!last || last.role !== 'user') {
      throw new Error('ReplayProvider requires the last message to be from user')
    }
    const fx = pickFixture(fixtures, last.content)

    for (const chunk of fx.chunks) {
      yield chunk
      await new Promise((r) => setTimeout(r, 5))
    }
  }

  async function chat(opts: ChatOpts): Promise<ChatResult> {
    const last = opts.messages[opts.messages.length - 1]
    if (!last || last.role !== 'user') {
      throw new Error('ReplayProvider requires the last message to be from user')
    }
    const fx = pickFixture(fixtures, last.content)
    return {
      content: fx.result.content,
      thinking: fx.result.thinking,
    }
  }

  return { chatStream, chat }
}
