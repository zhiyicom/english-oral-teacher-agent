import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  type Summary,
  SummarySchema,
  buildSummaryInstruction,
  summarize,
  truncateMessages,
} from '../../src/agent/summarizer.js'
import { createReplayProvider } from '../../src/llm/testing.js'
import type { LLMClient, Message } from '../../src/llm/types.js'

function makeMessage(role: 'user' | 'assistant', content: string): Message {
  return { role, content }
}

/** A minimal LLMClient stub that returns a fixed content string. */
function makeStubClient(content: string): LLMClient {
  return {
    async chat() {
      return { content }
    },
    async *chatStream() {
      // unused
    },
  }
}

/** A stub that throws — used for error path tests. */
function makeThrowingClient(): LLMClient {
  return {
    async chat() {
      throw new Error('LLM offline')
    },
    async *chatStream() {
      // unused
    },
  }
}

describe('SummarySchema (zod)', () => {
  it('accepts a valid input', () => {
    const input = {
      summary: 'Student talked about castles for 5 minutes.',
      keywords: ['castle', 'minecraft', 'creeper'],
    }
    expect(() => SummarySchema.parse(input)).not.toThrow()
  })

  it('rejects summary shorter than 20 chars', () => {
    const input = { summary: 'too short', keywords: ['a', 'b', 'c'] }
    expect(() => SummarySchema.parse(input)).toThrow()
  })

  it('rejects summary longer than 800 chars', () => {
    const input = {
      summary: 'x'.repeat(801),
      keywords: ['a', 'b', 'c'],
    }
    expect(() => SummarySchema.parse(input)).toThrow()
  })

  it('rejects fewer than 3 keywords', () => {
    const input = { summary: 'a'.repeat(30), keywords: ['only', 'two'] }
    expect(() => SummarySchema.parse(input)).toThrow()
  })

  it('rejects more than 8 keywords', () => {
    const input = {
      summary: 'a'.repeat(30),
      keywords: ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9'],
    }
    expect(() => SummarySchema.parse(input)).toThrow()
  })

  it('rejects missing summary field', () => {
    const input = { keywords: ['a', 'b', 'c'] }
    expect(() => SummarySchema.parse(input)).toThrow()
  })

  it('rejects missing keywords field', () => {
    const input = { summary: 'a'.repeat(30) }
    expect(() => SummarySchema.parse(input)).toThrow()
  })

  it('accepts boundary values (summary = 20 chars, 3 keywords)', () => {
    const input = { summary: 'x'.repeat(20), keywords: ['a', 'b', 'c'] }
    const out: Summary = SummarySchema.parse(input)
    expect(out.summary).toBe('x'.repeat(20))
    expect(out.keywords).toEqual(['a', 'b', 'c'])
  })
})

describe('truncateMessages', () => {
  it('returns short messages unchanged', () => {
    const msgs: Message[] = [
      makeMessage('user', 'hi'),
      makeMessage('assistant', 'hello'),
      makeMessage('user', 'bye'),
    ]
    expect(truncateMessages(msgs)).toEqual(msgs)
  })

  it('returns exact 25 messages unchanged (boundary)', () => {
    const msgs: Message[] = Array.from({ length: 25 }, (_, i) =>
      makeMessage(i % 2 === 0 ? 'user' : 'assistant', `m${i}`),
    )
    expect(truncateMessages(msgs)).toHaveLength(25)
  })

  it('truncates 30 messages to 25 (first 20 + last 5)', () => {
    const msgs: Message[] = Array.from({ length: 30 }, (_, i) => makeMessage('user', `m${i}`))
    const out = truncateMessages(msgs)
    expect(out).toHaveLength(25)
    expect(out[0]?.content).toBe('m0')
    expect(out[19]?.content).toBe('m19')
    expect(out[20]?.content).toBe('m25')
    expect(out[24]?.content).toBe('m29')
  })

  it('truncates 100 messages to 25', () => {
    const msgs: Message[] = Array.from({ length: 100 }, (_, i) => makeMessage('user', `m${i}`))
    const out = truncateMessages(msgs)
    expect(out).toHaveLength(25)
  })
})

describe('buildSummaryInstruction', () => {
  it('produces a single user message containing the SUMMARIZER_INSTRUCTION marker (for Replay fixture match)', () => {
    const req = buildSummaryInstruction()
    expect(req.role).toBe('user')
    expect(req.content).toContain('[SUMMARIZER_INSTRUCTION]')
  })

  it('does NOT contain transcript content (last user message must be the instruction only)', () => {
    const req = buildSummaryInstruction()
    // The marker-based fixture match must not collide with transcript words.
    // Verify the instruction body has no obvious transcript collisions:
    expect(req.content).not.toMatch(/\bcastle\b/i)
    expect(req.content).not.toMatch(/\bcreeper\b/i)
  })
})

describe('summarize (end-to-end with stub client)', () => {
  it('returns a parsed Summary when LLM returns valid JSON', async () => {
    const validJson = JSON.stringify({
      summary: 'Student talked about Minecraft for 5 minutes.',
      keywords: ['minecraft', 'castle', 'build'],
    })
    const out = await summarize(
      [makeMessage('user', 'hi'), makeMessage('assistant', 'hello')],
      makeStubClient(validJson),
    )
    expect(out.summary).toContain('Minecraft')
    expect(out.keywords).toEqual(['minecraft', 'castle', 'build'])
  })

  // v1.1.0 hotfix — LLM (temperature=0.7) frequently wraps JSON in
  // ```json...``` because the summarizer prompt's example uses that
  // format. Strip the fence before parse so the user doesn't see a
  // "(summarization failed)" placeholder. Regression coverage for
  // data/llm-debug/2026-07-14T13-29-53-* + 33 prior failures.
  it('strips ```json markdown fence before parsing (v1.1.0 hotfix)', async () => {
    const inner = JSON.stringify({
      summary: 'Student talked about cats and Minecraft for several turns.',
      keywords: ['cat', 'minecraft', 'castle'],
    })
    const fenced = '```json\n' + inner + '\n```'
    const out = await summarize(
      [makeMessage('user', 'hi'), makeMessage('assistant', 'hello')],
      makeStubClient(fenced),
    )
    expect(out.summary).toContain('cats')
    expect(out.keywords).toEqual(['cat', 'minecraft', 'castle'])
  })

  it('strips ``` fence without json language tag (defensive)', async () => {
    const inner = JSON.stringify({
      summary: 'Student talked about pets and toys for the entire session.',
      keywords: ['pet', 'toy', 'cat'],
    })
    const fenced = '```\n' + inner + '\n```'
    const out = await summarize(
      [makeMessage('user', 'hi'), makeMessage('assistant', 'hello')],
      makeStubClient(fenced),
    )
    expect(out.keywords).toEqual(['pet', 'toy', 'cat'])
  })

  it('passes the transcript + final instruction to the LLM (stub records what it received)', async () => {
    let received: Message[] = []
    const recordingClient: LLMClient = {
      async chat(opts) {
        received = opts.messages
        return {
          content: JSON.stringify({
            summary: 'Student talked about castles.',
            keywords: ['a', 'b', 'c'],
          }),
        }
      },
      async *chatStream() {
        // unused
      },
    }
    await summarize(
      [makeMessage('user', 'I built a castle'), makeMessage('assistant', 'Cool!')],
      recordingClient,
    )
    // transcript (2) + final instruction (1) = 3 messages
    expect(received).toHaveLength(3)
    expect(received[0]?.content).toBe('I built a castle')
    expect(received[1]?.content).toBe('Cool!')
    expect(received[2]?.content).toContain('[SUMMARIZER_INSTRUCTION]')
  })

  it('throws on non-JSON LLM response', async () => {
    await expect(
      summarize([makeMessage('user', 'hi')], makeStubClient('not json')),
    ).rejects.toThrow(/not valid JSON/)
  })

  it('throws on JSON that does not match SummarySchema (summary too short)', async () => {
    await expect(
      summarize(
        [makeMessage('user', 'hi')],
        makeStubClient(JSON.stringify({ summary: 'short', keywords: ['a', 'b', 'c'] })),
      ),
    ).rejects.toThrow()
  })

  it('throws on JSON missing keywords', async () => {
    await expect(
      summarize(
        [makeMessage('user', 'hi')],
        makeStubClient(JSON.stringify({ summary: 'a'.repeat(30) })),
      ),
    ).rejects.toThrow()
  })

  it('propagates the LLM client error (caller is responsible for fallback)', async () => {
    await expect(summarize([makeMessage('user', 'hi')], makeThrowingClient())).rejects.toThrow(
      /LLM offline/,
    )
  })

  it('truncates long transcripts before sending to LLM (recording client)', async () => {
    let received: Message[] = []
    const recordingClient: LLMClient = {
      async chat(opts) {
        received = opts.messages
        return {
          content: JSON.stringify({
            summary: 'Student talked about Minecraft for 30 minutes.',
            keywords: ['minecraft', 'castle', 'build'],
          }),
        }
      },
      async *chatStream() {
        // unused
      },
    }
    const long: Message[] = Array.from({ length: 50 }, (_, i) => makeMessage('user', `msg${i}`))
    await summarize(long, recordingClient)
    // 25 truncated transcript messages (first 20 + last 5) + 1 final instruction = 26
    expect(received).toHaveLength(26)
    expect(received[0]?.content).toBe('msg0')
    expect(received[19]?.content).toBe('msg19')
    expect(received[20]?.content).toBe('msg45')
    expect(received[24]?.content).toBe('msg49')
    expect(received[25]?.content).toContain('[SUMMARIZER_INSTRUCTION]')
  })
})

describe('summarize.json fixture', () => {
  it('parses as valid Summary through the schema', () => {
    const raw = readFileSync(resolve('tests/fixtures/replay/summarize.json'), 'utf-8')
    const parsed = JSON.parse(raw)
    expect(parsed.result.content).toBeDefined()
    const asSummary = JSON.parse(parsed.result.content)
    expect(() => SummarySchema.parse(asSummary)).not.toThrow()
  })
})

describe('summarize with real ReplayProvider (integration smoke)', () => {
  it('loads summarize.json and returns a Summary matching the fixture', async () => {
    const client = createReplayProvider(resolve('tests/fixtures/replay'))
    const out = await summarize(
      [makeMessage('user', 'I built a castle'), makeMessage('assistant', 'Cool castle!')],
      client,
    )
    expect(out.summary).toContain('Minecraft')
    expect(out.keywords.length).toBeGreaterThanOrEqual(3)
  })
})
