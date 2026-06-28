import { describe, expect, it } from 'vitest'
import {
  type StudentDiscoveries,
  extractStudentDiscoveries,
} from '../../src/agent/profile-extractor.js'
import type { ChatResult, LLMClient } from '../../src/llm/types.js'

function stubClient(responses: ChatResult[]): LLMClient {
  let i = 0
  return {
    // unused — profile-extractor only calls .chat()
    async *chatStream() {
      /* no-op */
    },
    async chat(): Promise<ChatResult> {
      const r = responses[i++] ?? responses[responses.length - 1]
      if (!r) throw new Error('stubClient: no responses left')
      return r
    },
  }
}

describe('extractStudentDiscoveries (v1.0.3 §1.3 — nextWarmUpSeed)', () => {
  it('parses a complete JSON payload (interests + body + seed)', async () => {
    const client = stubClient([
      {
        content: JSON.stringify({
          new_interests: ['cello', 'rock music'],
          body_update: 'Student plays cello for 8 years.',
          next_warm_up_seed: 'cello',
        }),
      },
    ])
    const result: StudentDiscoveries = await extractStudentDiscoveries(
      'Student talked about playing cello.',
      [],
      client,
    )
    expect(result.newInterests).toEqual(['cello', 'rock music'])
    expect(result.bodyUpdate).toBe('Student plays cello for 8 years.')
    expect(result.nextWarmUpSeed).toBe('cello')
  })

  it('trims whitespace around the seed', async () => {
    const client = stubClient([
      {
        content: JSON.stringify({
          new_interests: [],
          body_update: null,
          next_warm_up_seed: '   minecraft  ',
        }),
      },
    ])
    const result = await extractStudentDiscoveries('summary', [], client)
    expect(result.nextWarmUpSeed).toBe('minecraft')
  })

  it('treats empty string seed as null', async () => {
    // LLM sometimes returns "" when there's no good opener — must NOT pass
    // an empty string to the WARM_UP hint (which checks truthy).
    const client = stubClient([
      {
        content: JSON.stringify({
          new_interests: [],
          body_update: null,
          next_warm_up_seed: '   ',
        }),
      },
    ])
    const result = await extractStudentDiscoveries('summary', [], client)
    expect(result.nextWarmUpSeed).toBeNull()
  })

  it('treats missing seed field as null (backwards compat with old LLM)', async () => {
    // If a future profile-extract prompt drops the field, or a pre-v1.0.3
    // model returns an older shape, the parser must not crash.
    const client = stubClient([
      {
        content: JSON.stringify({
          new_interests: ['chess'],
          body_update: null,
          // next_warm_up_seed intentionally absent
        }),
      },
    ])
    const result = await extractStudentDiscoveries('summary', [], client)
    expect(result.nextWarmUpSeed).toBeNull()
    expect(result.newInterests).toEqual(['chess'])
  })

  it('treats non-string seed as null', async () => {
    const client = stubClient([
      {
        content: JSON.stringify({
          new_interests: [],
          body_update: null,
          next_warm_up_seed: 42, // wrong type
        }),
      },
    ])
    const result = await extractStudentDiscoveries('summary', [], client)
    expect(result.nextWarmUpSeed).toBeNull()
  })

  it('explicit null seed is preserved as null', async () => {
    const client = stubClient([
      {
        content: JSON.stringify({
          new_interests: [],
          body_update: null,
          next_warm_up_seed: null,
        }),
      },
    ])
    const result = await extractStudentDiscoveries('summary', [], client)
    expect(result.nextWarmUpSeed).toBeNull()
  })

  it('falls back to all-null on malformed JSON', async () => {
    const client = stubClient([{ content: 'not json at all' }])
    const result = await extractStudentDiscoveries('summary', [], client)
    expect(result).toEqual({ newInterests: [], bodyUpdate: null, nextWarmUpSeed: null })
  })

  it('passes existing interests hint to the prompt when non-empty', async () => {
    // Smoke test: the prompt text contains the known-interests list, so the
    // LLM can dedupe (e.g. avoid re-adding "minecraft" if it's already known).
    let captured: string | undefined
    const client: LLMClient = {
      // unused — profile-extractor only calls .chat()
      async *chatStream() {
        /* no-op */
      },
      async chat(opts) {
        captured = opts.messages[0]?.content
        return {
          content: JSON.stringify({
            new_interests: [],
            body_update: null,
            next_warm_up_seed: null,
          }),
        }
      },
    }
    await extractStudentDiscoveries('summary', ['minecraft', 'pizza'], client)
    expect(captured).toContain('Current known interests: minecraft, pizza')
  })

  it('omits the interests hint when existing list is empty', async () => {
    let captured: string | undefined
    const client: LLMClient = {
      // unused — profile-extractor only calls .chat()
      async *chatStream() {
        /* no-op */
      },
      async chat(opts) {
        captured = opts.messages[0]?.content
        return {
          content: JSON.stringify({
            new_interests: [],
            body_update: null,
            next_warm_up_seed: null,
          }),
        }
      },
    }
    await extractStudentDiscoveries('summary', [], client)
    expect(captured).not.toContain('Current known interests')
  })
})
