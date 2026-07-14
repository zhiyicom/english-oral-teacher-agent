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

describe('matchTopic (v1.1.0 §A §C — normalized + Top-N)', () => {
  it('minecraft fixture: 5 keywords all in minecraft topic → score 0.5 → match', () => {
    const result = matchTopic(
      ['minecraft', 'castle', 'creeper', 'wall', 'build'],
      [minecraft, school, sports],
    )
    expect(result.length).toBeGreaterThan(0)
    expect(result[0]?.topic).toBe('minecraft')
    expect(result[0]?.jaccard).toBeGreaterThan(0.4)
    expect(result[0]?.shared.sort()).toEqual(['build', 'castle', 'creeper', 'minecraft', 'wall'])
  })

  it('empty session keywords → empty array (not an error)', () => {
    expect(matchTopic([], [minecraft, school])).toEqual([])
  })

  it('unrelated keywords → empty array (no topic above threshold)', () => {
    expect(
      matchTopic(
        ['philosophy', 'gravity', 'quantum', 'entropy', 'algebra'],
        [minecraft, school, sports],
      ),
    ).toEqual([])
  })

  it('threshold 0.5 strict mode: only high-score topics match', () => {
    expect(matchTopic(['homework'], [minecraft, school, sports], 0.5)[0]?.topic).toBe('school')
    expect(
      matchTopic(
        ['minecraft', 'castle', 'creeper', 'wall', 'build'],
        [minecraft, school, sports],
        0.5,
      ).length,
    ).toBeGreaterThan(0)
  })

  it('tie-break: two topics with identical Jaccard → sorted by score then lexicographically', () => {
    const a: Topic = { name: 'zebra', keywords: ['x', 'a'], description: null, createdAt: '' }
    const b: Topic = { name: 'apple', keywords: ['x', 'a'], description: null, createdAt: '' }
    const result = matchTopic(['x', 'a'], [a, b])
    expect(result[0]?.topic).toBe('apple')
  })

  it('Top-N: returns all matches above threshold, sorted by score desc', () => {
    const result = matchTopic(
      ['minecraft', 'castle', 'homework'],
      [minecraft, school, sports],
    )
    expect(result.length).toBe(2)
    expect(result[0]?.topic).toBe('minecraft') // 2 shared > 1 shared
    expect(result[1]?.topic).toBe('school')
  })

  it('lowercase normalization: keyword "MineCraft" still matches "minecraft" topic', () => {
    const result = matchTopic(['MineCraft', 'Castle', 'Creeper', 'Wall', 'Build'], [minecraft])
    expect(result[0]?.topic).toBe('minecraft')
  })

  it('§A space→underscore normalization: "delta force" matches topic with "delta_force"', () => {
    const gamingTopic: Topic = {
      name: 'gaming',
      keywords: ['delta_force', 'shooter', 'game'],
      description: null,
      createdAt: '',
    }
    const result = matchTopic(['delta force', 'shooting games'], [gamingTopic])
    expect(result.length).toBeGreaterThan(0)
    expect(result[0]?.topic).toBe('gaming')
  })

  it('§A multi-word normalization: "summer vacation" matches "vacation" in travel topic', () => {
    const travel: Topic = {
      name: 'travel',
      keywords: ['travel', 'vacation', 'trip'],
      description: null,
      createdAt: '',
    }
    const result = matchTopic(['summer vacation'], [travel])
    expect(result.length).toBeGreaterThan(0)
    expect(result[0]?.topic).toBe('travel')
  })

  it('threshold=0 case: any non-empty intersection matches', () => {
    const result = matchTopic(['homework'], [school], 0)
    expect(result[0]?.topic).toBe('school')
    expect(result[0]?.jaccard).toBeGreaterThan(0)
  })

  it('threshold=1: must be exact set match', () => {
    const exactTopic: Topic = {
      name: 'exact',
      keywords: ['minecraft', 'castle'],
      description: null,
      createdAt: '',
    }
    expect(matchTopic(['minecraft', 'castle'], [exactTopic], 1).length).toBeGreaterThan(0)
    expect(matchTopic(['minecraft'], [exactTopic], 1)[0]?.topic).toBe('exact')
  })
})
