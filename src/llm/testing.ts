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

/**
 * v0.7.6 — LLM test provider that throws a configured error on every call.
 * Used by V751-002 L3 tests to exercise the CLI's catch-all + auto-save
 * path. Error shape mirrors the Anthropic SDK's `APIError` (with a `.status`
 * field) so `classifyLLMError` can classify it correctly.
 *
 * Set `LLM_TEST_FAIL=<status>` (e.g. `500`, `429`, `401`) to enable. See
 * tests/agent/cli-integration.test.ts for usage.
 */
export function createThrowingProvider(status: number, message = 'mock LLM failure'): LLMClient {
  const err = new Error(message) as Error & { status: number }
  err.status = status

  return {
    async *chatStream(_opts: ChatOpts): AsyncIterable<ChatChunk> {
      // Throw immediately when iteration starts (mimics Anthropic SDK
      // raising the error mid-stream). The `await Promise.resolve()` is
      // not strictly needed; the throw is the first body statement so
      // it fires on the first `.next()` call from `for await`.
      // biome-ignore lint/correctness/useYield: throw-only iterator; no chunks yielded by design
      throw err
    },
    async chat(_opts: ChatOpts): Promise<ChatResult> {
      throw err
    },
  }
}
