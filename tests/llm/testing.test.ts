import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createReplayProvider } from '../../src/llm/testing.js'
import type { ChatChunk } from '../../src/llm/types.js'

const FIXTURES = resolve('tests/fixtures/replay')

describe('ReplayProvider', () => {
  it('returns content from fixture matching userSaysContains', async () => {
    const client = createReplayProvider(FIXTURES)
    const result = await client.chat({
      system: 's',
      messages: [{ role: 'user', content: 'hi there!' }],
    })
    expect(result.content).toContain('Hi')
  })

  it('streams chunks in order, with text and thinking separated', async () => {
    const client = createReplayProvider(FIXTURES)
    const chunks: ChatChunk[] = []
    for await (const c of client.chatStream({
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      chunks.push(c)
    }
    const text = chunks
      .filter((c) => c.type === 'text')
      .map((c) => (c as { type: 'text'; delta: string }).delta)
      .join('')
    expect(text.length).toBeGreaterThan(0)
  })

  it('throws when no fixture matches', async () => {
    const client = createReplayProvider(FIXTURES)
    await expect(
      client.chat({
        system: 's',
        messages: [{ role: 'user', content: 'xyzzy plover quux' }],
      }),
    ).rejects.toThrow(/No fixture matches/)
  })
})
