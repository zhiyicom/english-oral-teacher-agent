import { describe, expect, it } from 'vitest'
import { retrieveRelevant } from '../../src/memory/retrieve-relevant.js'
import type { SessionWithEmbedding } from '../../src/storage/sessions.js'

function candidate(
  id: string,
  startedAt: string,
  embedding: Float32Array,
  summary = `summary-${id}`,
  keywords: string[] = [],
): SessionWithEmbedding {
  return { id, startedAt, summary, keywords, embedding }
}

describe('retrieveRelevant', () => {
  it('sorts by cosine similarity descending, returns top-K', () => {
    const query = new Float32Array([1, 0, 0])
    const candidates: SessionWithEmbedding[] = [
      // perpendicular to query → similarity 0
      candidate('low', '2026-06-01T00:00:00.000Z', new Float32Array([0, 1, 0])),
      // identical to query → similarity 1 (best)
      candidate('best', '2026-06-02T00:00:00.000Z', new Float32Array([1, 0, 0])),
      // 45° off → similarity ~0.707 (middle)
      candidate('mid', '2026-06-03T00:00:00.000Z', new Float32Array([1, 1, 0])),
    ]
    const result = retrieveRelevant({
      candidates,
      queryVec: query,
      topK: 2,
      now: new Date('2026-06-10T00:00:00.000Z'),
    })
    expect(result.map((r) => r.sessionId)).toEqual(['best', 'mid'])
    expect(result[0]?.similarity).toBeCloseTo(1, 6)
    expect(result[1]?.similarity).toBeCloseTo(Math.SQRT1_2, 6)
    // daysAgo computed from now (2026-06-10)
    expect(result[0]?.daysAgo).toBe(8) // best = 2026-06-02
    expect(result[1]?.daysAgo).toBe(7) // mid = 2026-06-03
  })

  it('excludes excludeSessionId even if it is the most similar', () => {
    const query = new Float32Array([1, 0, 0])
    const candidates: SessionWithEmbedding[] = [
      candidate('self', '2026-06-09T00:00:00.000Z', new Float32Array([1, 0, 0])),
      candidate('other', '2026-06-08T00:00:00.000Z', new Float32Array([1, 1, 0])),
    ]
    const result = retrieveRelevant({
      candidates,
      queryVec: query,
      topK: 5,
      excludeSessionId: 'self',
      now: new Date('2026-06-10T00:00:00.000Z'),
    })
    expect(result.map((r) => r.sessionId)).toEqual(['other'])
  })

  it('returns empty array when candidates is empty', () => {
    const result = retrieveRelevant({
      candidates: [],
      queryVec: new Float32Array([1, 0, 0]),
      topK: 5,
    })
    expect(result).toEqual([])
  })
})
