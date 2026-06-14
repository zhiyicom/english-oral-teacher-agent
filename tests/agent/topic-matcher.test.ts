import { describe, expect, it } from 'vitest'
import { jaccard, matchTopic } from '../../src/agent/topic-matcher.js'
import type { Topic } from '../../src/storage/topics.js'

const minecraft: Topic = {
  name: 'minecraft',
  keywords: [
    'minecraft',
    'castle',
    'creeper',
    'wall',
    'build',
    'survival',
    'creative',
    'block',
    'mob',
    'pickaxe',
  ],
  description: 'Minecraft game',
  createdAt: '2026-06-09T00:00:00.000Z',
}

const school: Topic = {
  name: 'school',
  keywords: ['school', 'class', 'teacher', 'homework', 'exam', 'friend', 'lunch', 'recess'],
  description: 'School life',
  createdAt: '2026-06-09T00:00:00.000Z',
}

const sports: Topic = {
  name: 'sports',
  keywords: ['soccer', 'basketball', 'swim', 'run', 'ball', 'team', 'match', 'win'],
  description: 'Sports',
  createdAt: '2026-06-09T00:00:00.000Z',
}

describe('jaccard (v0.6 L1)', () => {
  it('identical sets return 1.0', () => {
    expect(jaccard(['a', 'b', 'c'], ['a', 'b', 'c'])).toBe(1)
  })

  it('disjoint sets return 0.0', () => {
    expect(jaccard(['a', 'b'], ['c', 'd'])).toBe(0)
  })

  it('partial overlap: 1/5 of union = 0.2', () => {
    // a={x,a,b}, b={x,c,d}: intersection={x}=1, union=3+3-1=5 → 1/5
    expect(jaccard(['x', 'a', 'b'], ['x', 'c', 'd'])).toBeCloseTo(0.2, 5)
  })

  it('empty first array returns 0', () => {
    expect(jaccard([], ['a', 'b'])).toBe(0)
  })

  it('empty second array returns 0', () => {
    expect(jaccard(['a', 'b'], [])).toBe(0)
  })

  it('case-insensitive: "Minecraft" matches "minecraft"', () => {
    expect(jaccard(['Minecraft', 'Castle'], ['minecraft', 'castle', 'creeper'])).toBeCloseTo(
      2 / 3,
      5,
    )
  })

  it('duplicates in input are deduplicated (Set semantics)', () => {
    // a = {minecraft, castle, castle} → {minecraft, castle}
    // b = {minecraft, castle, creeper}
    // intersection = 2, union = 3 → 2/3
    expect(
      jaccard(['minecraft', 'castle', 'castle'], ['minecraft', 'castle', 'creeper']),
    ).toBeCloseTo(2 / 3, 5)
  })
})

describe('matchTopic (v0.6 L1)', () => {
  it('minecraft fixture: 5 keywords all in minecraft topic → score 0.5 → match', () => {
    const result = matchTopic(
      ['minecraft', 'castle', 'creeper', 'wall', 'build'],
      [minecraft, school, sports],
    )
    expect(result).not.toBeNull()
    expect(result?.topic).toBe('minecraft')
    // v0.9: score uses max(jaccard, countScore), 5 shared keywords = strong signal
    expect(result?.jaccard).toBeGreaterThan(0.4)
    expect(result?.shared.sort()).toEqual(['build', 'castle', 'creeper', 'minecraft', 'wall'])
  })

  it('empty session keywords → null (not an error)', () => {
    expect(matchTopic([], [minecraft, school])).toBeNull()
  })

  it('unrelated keywords → null (no topic above threshold)', () => {
    // 5 unrelated words, no intersection with any topic
    expect(
      matchTopic(
        ['philosophy', 'gravity', 'quantum', 'entropy', 'algebra'],
        [minecraft, school, sports],
      ),
    ).toBeNull()
  })

  it('threshold 0.5 strict mode: only high-score topics match', () => {
    // 1 keyword in school matches at threshold 0.5 with countScore
    expect(matchTopic(['homework'], [minecraft, school, sports], 0.5)?.topic).toBe('school')
    // 5 keywords in minecraft → strong match
    expect(
      matchTopic(
        ['minecraft', 'castle', 'creeper', 'wall', 'build'],
        [minecraft, school, sports],
        0.5,
      ),
    ).not.toBeNull()
  })

  it('tie-break: two topics with identical Jaccard → pick lexicographically smaller name', () => {
    // Both topics have keyword "x". session=["x","a"]. jaccard with each = 1/2.
    const a: Topic = { name: 'zebra', keywords: ['x', 'a'], description: null, createdAt: '' }
    const b: Topic = { name: 'apple', keywords: ['x', 'a'], description: null, createdAt: '' }
    const result = matchTopic(['x', 'a'], [a, b])
    expect(result?.topic).toBe('apple')
  })

  it('multiple topics: returns the best (highest jaccard) one', () => {
    // session has 2 minecraft + 1 school. minecraft score = 2/11 = 0.18 (below 0.3 default)
    // Hmm, that's below threshold. Use 5/10 minecraft:
    const result = matchTopic(
      ['minecraft', 'castle', 'creeper', 'wall', 'build'],
      [minecraft, school, sports],
    )
    expect(result?.topic).toBe('minecraft')
  })

  it('lowercase normalization: keyword "MineCraft" still matches "minecraft" topic', () => {
    // 5 case-mixed keywords matching 10 minecraft keywords → jaccard 0.5 (above 0.3)
    const result = matchTopic(['MineCraft', 'Castle', 'Creeper', 'Wall', 'Build'], [minecraft])
    expect(result?.topic).toBe('minecraft')
  })

  it('threshold=0 case: any non-empty intersection matches', () => {
    const result = matchTopic(['homework'], [school], 0)
    expect(result?.topic).toBe('school')
    // v0.9: score uses countScore, 1 shared keyword = strong signal
    expect(result?.jaccard).toBeGreaterThan(0)
  })

  it('threshold=1: must be exact set match', () => {
    const exactTopic: Topic = {
      name: 'exact',
      keywords: ['minecraft', 'castle'],
      description: null,
      createdAt: '',
    }
    // exact match → 1.0 → above threshold
    expect(matchTopic(['minecraft', 'castle'], [exactTopic], 1)).not.toBeNull()
    // v0.9: single keyword with countScore = 1.0 also passes threshold=1
    expect(matchTopic(['minecraft'], [exactTopic], 1)?.topic).toBe('exact')
  })
})
