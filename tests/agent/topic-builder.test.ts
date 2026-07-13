import { describe, expect, it } from 'vitest'
import {
  type ProposedTopic,
  extractNewTopicFromKeywords,
} from '../../src/agent/topic-builder.js'
import type { ChatResult, LLMClient } from '../../src/llm/types.js'

function stubClient(responses: ChatResult[]): LLMClient {
  let i = 0
  return {
    async *chatStream() {
      /* unused */
    },
    async chat(): Promise<ChatResult> {
      const r = responses[i++] ?? responses[responses.length - 1]
      if (!r) throw new Error('stubClient: no responses left')
      return r
    },
  }
}

function throwingClient(): LLMClient {
  return {
    async *chatStream() {
      /* unused */
    },
    async chat(): Promise<ChatResult> {
      throw new Error('network down')
    },
  }
}

const EXISTING = ['food_drink', 'travel', 'music', 'aviation', 'gaming']

describe('extractNewTopicFromKeywords (v1.1.0 §1.4)', () => {
  it('B1: returns null on empty keywords', async () => {
    const client = stubClient([])
    const result = await extractNewTopicFromKeywords([], EXISTING, client)
    expect(result).toBeNull()
  })

  it('B2: parses a valid should_create=true response', async () => {
    const client = stubClient([
      {
        content: JSON.stringify({
          should_create: true,
          name: 'ceramics',
          keywords: ['pottery', 'ceramics', 'kiln', 'glaze', 'clay'],
          description: 'Ceramics & pottery — making, firing, glazing (A2-B1)',
        }),
      },
    ])
    const result: ProposedTopic | null = await extractNewTopicFromKeywords(
      ['pottery', 'ceramics', 'kiln'],
      EXISTING,
      client,
    )
    expect(result).toEqual({
      name: 'ceramics',
      keywords: ['pottery', 'ceramics', 'kiln', 'glaze', 'clay'],
      description: 'Ceramics & pottery — making, firing, glazing (A2-B1)',
    })
  })

  it('B3: declines when should_create=false', async () => {
    const client = stubClient([
      {
        content: JSON.stringify({
          should_create: false,
        }),
      },
    ])
    const result = await extractNewTopicFromKeywords(['ok', 'yes'], EXISTING, client)
    expect(result).toBeNull()
  })

  it('B4: rejects slug that collides with an existing topic name', async () => {
    const client = stubClient([
      {
        content: JSON.stringify({
          should_create: true,
          name: 'food_drink',
          keywords: ['cuisine', 'tasting'],
          description: 'Should be rejected',
        }),
      },
    ])
    const result = await extractNewTopicFromKeywords(['cuisine'], EXISTING, client)
    expect(result).toBeNull()
  })

  it.each([
    ['with spaces', 'space art'],
    ['all uppercase', 'SPACE_ART'],
    ['too short (2 chars)', 'ab'],
    ['too long (31 chars)', 'a23456789012345678901234567890b'],
    ['starts with digit', '4_seasons'],
    ['contains hyphen', 'space-art'],
    ['contains dot', 'space.art'],
  ])('B5: rejects invalid slug (%s)', async (_label, badSlug) => {
    const client = stubClient([
      {
        content: JSON.stringify({
          should_create: true,
          name: badSlug,
          keywords: ['art', 'painting'],
          description: 'A valid description',
        }),
      },
    ])
    const result = await extractNewTopicFromKeywords(['art', 'painting'], EXISTING, client)
    expect(result).toBeNull()
  })

  it('B6: rejects when keywords array has fewer than 2 valid tokens after cleanup', async () => {
    // After cleanup (lowercase, trim, length >=2, not pure digit) only "ok"
    // remains — must reject.
    const client = stubClient([
      {
        content: JSON.stringify({
          should_create: true,
          name: 'tiny_topic',
          keywords: ['ok', '5', ' '],
          description: 'Insufficient keywords',
        }),
      },
    ])
    const result = await extractNewTopicFromKeywords(['ok'], EXISTING, client)
    expect(result).toBeNull()
  })

  it('B7: cleans keywords: lowercases, trims, drops pure-numeric, caps at 15', async () => {
    const client = stubClient([
      {
        content: JSON.stringify({
          should_create: true,
          name: 'ceramics',
          keywords: [
            '  POTTERY  ',
            'kiln',
            '5',
            'ok',
            'glaze',
            'clay',
            ...Array.from({ length: 20 }, (_, i) => `extra${i}`),
          ],
          description: 'Ceramics',
        }),
      },
    ])
    const result = await extractNewTopicFromKeywords(
      ['pottery', 'kiln'],
      EXISTING,
      client,
    )
    expect(result).not.toBeNull()
    // 5 dropped (pure numeric), 'ok' dropped (length<2), rest cleaned +
    // capped to 15
    expect(result!.keywords[0]).toBe('pottery')
    expect(result!.keywords).not.toContain('5')
    expect(result!.keywords).not.toContain('ok')
    expect(result!.keywords.length).toBeLessThanOrEqual(15)
  })

  it('B8: rejects when description is empty', async () => {
    const client = stubClient([
      {
        content: JSON.stringify({
          should_create: true,
          name: 'ceramics',
          keywords: ['pottery', 'kiln'],
          description: '   ',
        }),
      },
    ])
    const result = await extractNewTopicFromKeywords(['pottery'], EXISTING, client)
    expect(result).toBeNull()
  })

  it('B9: rejects when description exceeds 200 chars', async () => {
    const longDesc = 'a'.repeat(201)
    const client = stubClient([
      {
        content: JSON.stringify({
          should_create: true,
          name: 'ceramics',
          keywords: ['pottery', 'kiln'],
          description: longDesc,
        }),
      },
    ])
    const result = await extractNewTopicFromKeywords(['pottery'], EXISTING, client)
    expect(result).toBeNull()
  })

  it('B10: returns null on LLM JSON parse error', async () => {
    const client = stubClient([{ content: 'not json {{' }])
    const result = await extractNewTopicFromKeywords(['pottery'], EXISTING, client)
    expect(result).toBeNull()
  })

  it('B11: returns null on LLM client throw', async () => {
    const result = await extractNewTopicFromKeywords(['pottery'], EXISTING, throwingClient())
    expect(result).toBeNull()
  })

  it('B12: rejects non-object response', async () => {
    const client = stubClient([{ content: 'null' }])
    const result = await extractNewTopicFromKeywords(['pottery'], EXISTING, client)
    expect(result).toBeNull()
  })

  it('B13: rejects when should_create is not strictly true (truthy coercion)', async () => {
    // "true" / 1 / "yes" all must NOT pass; only literal true.
    const client = stubClient([
      {
        content: JSON.stringify({
          should_create: 'true',
          name: 'ceramics',
          keywords: ['pottery', 'kiln'],
          description: 'ok',
        }),
      },
    ])
    const result = await extractNewTopicFromKeywords(['pottery'], EXISTING, client)
    expect(result).toBeNull()
  })

  it('B14: rejects when name is missing', async () => {
    const client = stubClient([
      {
        content: JSON.stringify({
          should_create: true,
          keywords: ['pottery', 'kiln'],
          description: 'ok',
        }),
      },
    ])
    const result = await extractNewTopicFromKeywords(['pottery'], EXISTING, client)
    expect(result).toBeNull()
  })
})
