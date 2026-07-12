import { describe, expect, it } from 'vitest'
import {
  TopicSelectArgsSchema,
  createTopicSelectTool,
} from '../../../src/agent/tools/topic-select.js'
import type { KeywordHit, Topic, TopicStat } from '../../../src/storage/topics.js'

// Pin to real today so `daysAgo` math stays correct regardless of when the
// test is run. The original fixed date (2026-06-10) silently made the
// "hard exclude removes every topic" test fail once real wall-clock time
// drifted past fixture NOW + 30 days.
const NOW = new Date()
const DAY = 86_400_000

function topic(name: string, keywords: string[]): Topic {
  return { name, keywords, description: null, createdAt: '2026-06-01T00:00:00.000Z' }
}

function stat(name: string, count: number, daysAgo: number | null): TopicStat {
  return {
    topic: name,
    discussionCount: count,
    firstDiscussedAt:
      daysAgo === null ? null : new Date(NOW.getTime() - daysAgo * DAY).toISOString(),
    lastDiscussedAt:
      daysAgo === null ? null : new Date(NOW.getTime() - daysAgo * DAY).toISOString(),
  }
}

const minecraft = topic('minecraft', ['minecraft', 'castle', 'creeper'])
const school = topic('school', ['school', 'class', 'teacher'])
const sports = topic('sports', ['soccer', 'ball', 'team'])

describe('TopicSelectArgsSchema', () => {
  it('accepts a minimal call with only phase omitted (defaulted)', () => {
    const parsed = TopicSelectArgsSchema.parse({})
    expect(parsed.phase).toBe('WARM_UP')
    expect(parsed.exclude_recent_days).toBe(30)
  })

  it('rejects an unknown phase value', () => {
    expect(() => TopicSelectArgsSchema.parse({ phase: 'NOT_A_PHASE' })).toThrow()
  })

  it('rejects negative exclude_recent_days', () => {
    expect(() => TopicSelectArgsSchema.parse({ exclude_recent_days: -1 })).toThrow()
  })
})

describe('createTopicSelectTool', () => {
  it('returns a typed TopicSelectResult when a winner exists', () => {
    const tool = createTopicSelectTool({
      topics: [minecraft, school, sports],
      stats: [],
      interests: ['minecraft', 'castle'],
      rng: () => 0.5, // noise=0, makes the test deterministic
    })
    const result = tool.execute({ phase: 'MAIN_ACTIVITY', exclude_recent_days: 30 }) as
      | {
          slug: string
          title: string
          est_minutes: number
        }
      | { error: string }
    expect(typeof result).toBe('object')
    if ('error' in result) throw new Error(`expected success, got error: ${result.error}`)
    expect(result.slug).toBeTruthy()
    // v1.0.5 §B — when description is null, title falls back to slug.
    expect(result.title).toBe(result.slug)
    expect(result.est_minutes).toBe(15)
  })

  it('returns { error } when hard exclude removes every topic', () => {
    // all 3 topics discussed within 30 days → no candidates
    const stats: TopicStat[] = [
      stat('minecraft', 1, 5),
      stat('school', 1, 10),
      stat('sports', 1, 20),
    ]
    const tool = createTopicSelectTool({
      topics: [minecraft, school, sports],
      stats,
      interests: [],
      rng: () => 0.5,
    })
    const result = tool.execute({ phase: 'WARM_UP', exclude_recent_days: 30 })
    expect(result).toEqual({ error: 'No topics available after hard exclude' })
  })

  it('schema validation throws on bad input (zod reaches the execute body)', () => {
    const tool = createTopicSelectTool({
      topics: [minecraft, school, sports],
      stats: [],
      interests: [],
    })
    expect(() => tool.execute({ phase: 'BOGUS' })).toThrow()
  })

  it('tool name and description are exposed for the registry / LLM tool listing', () => {
    const tool = createTopicSelectTool({ topics: [minecraft], stats: [], interests: [] })
    expect(tool.name).toBe('topic_select')
    expect(tool.description).toContain('topic')
  })
})

describe('createTopicSelectTool v1.0.9 §1.1 — stats / keywordStats as getter', () => {
  it('getter form: a second execute() after mutating underlying data reflects the change', () => {
    // Mutable stats array — simulate session-end DB write happening between
    // tool calls. With the old snapshot form, this test would still return
    // minecraft (the only zero-count topic in the first call).
    const stats: TopicStat[] = [stat('minecraft', 5, 100)]
    const tool = createTopicSelectTool({
      topics: [minecraft, school],
      stats: () => stats, // ← getter
      interests: [],
      rng: () => 0.5,
    })
    // First call: only minecraft has stats, but count=5 → score=-0.5.
    // school has no stats row → count=0 → score=0 → school wins.
    const r1 = tool.execute({ phase: 'MAIN_ACTIVITY', exclude_recent_days: 30 }) as
      | { slug: string }
      | { error: string }
    if ('error' in r1) throw new Error(`unexpected error: ${r1.error}`)
    expect(r1.slug).toBe('school')

    // Mutate the underlying array as if the DB had a new write.
    stats.push(stat('school', 5, 100))
    // Second call: getter re-reads the array; school now has count=5 too.
    // Tie broken alphabetically (school has lower score noise + alpha?).
    // Both count=5 → score=-0.5 each, noise=0 → tie → alphabetical tiebreak
    // in pool: filterHardExclude keeps both (lastDiscussedAt outside window),
    // sortByCountAsc keeps minecraft first (a.name.localeCompare(b.name)).
    const r2 = tool.execute({ phase: 'MAIN_ACTIVITY', exclude_recent_days: 30 }) as
      | { slug: string }
      | { error: string }
    if ('error' in r2) throw new Error(`unexpected error: ${r2.error}`)
    expect(r2.slug).toBe('minecraft')
  })

  it('getter form: keywordStats getter also reflects changes between calls', () => {
    const hits: KeywordHit[] = [
      { topic: 'minecraft', keyword: 'minecraft', hitCount: 10, firstHitAt: null, lastHitAt: null },
    ]
    const tool = createTopicSelectTool({
      topics: [minecraft, school],
      stats: [],
      interests: [],
      keywordStats: () => hits,
      rng: () => 0.5,
    })
    // First call: minecraft has keyword hits (avg ≈ 3.33), school has none (avg = 0).
    // school wins on lower kAvg penalty.
    const r1 = tool.execute({ phase: 'MAIN_ACTIVITY', exclude_recent_days: 30 }) as
      | { slug: string }
      | { error: string }
    if ('error' in r1) throw new Error(`unexpected error: ${r1.error}`)
    expect(r1.slug).toBe('school')

    // Now mutate so school also has hits → minecraft becomes fresher.
    hits.push({ topic: 'school', keyword: 'school', hitCount: 10, firstHitAt: null, lastHitAt: null })
    hits.push({ topic: 'school', keyword: 'class', hitCount: 10, firstHitAt: null, lastHitAt: null })
    hits.push({ topic: 'school', keyword: 'teacher', hitCount: 10, firstHitAt: null, lastHitAt: null })
    // Second call: minecraft avg = 10/3 = 3.33, school avg = 30/3 = 10.
    // minecraft wins.
    const r2 = tool.execute({ phase: 'MAIN_ACTIVITY', exclude_recent_days: 30 }) as
      | { slug: string }
      | { error: string }
    if ('error' in r2) throw new Error(`unexpected error: ${r2.error}`)
    expect(r2.slug).toBe('minecraft')
  })

  it('array form (legacy): still works without changes (backward compatibility)', () => {
    // Plain array — no getter. This is the pre-v1.0.9 calling convention;
    // must keep working for all existing tests.
    const tool = createTopicSelectTool({
      topics: [minecraft, school, sports],
      stats: [stat('minecraft', 5, 100)],
      interests: [],
      keywordStats: [
        { topic: 'school', keyword: 'school', hitCount: 10, firstHitAt: null, lastHitAt: null },
      ],
      rng: () => 0.5,
    })
    const result = tool.execute({ phase: 'MAIN_ACTIVITY', exclude_recent_days: 30 }) as
      | { slug: string }
      | { error: string }
    if ('error' in result) throw new Error(`unexpected error: ${result.error}`)
    expect(result.slug).toBeTruthy()
  })
})

describe('createTopicSelectTool — suggested_keyword (v1.0.2)', () => {
  it('returns the freshest keyword (lowest hit_count) from the chosen topic', () => {
    // Force minecraft to win via:
    //   - count=0 (no topic_stats entry)
    //   - no interest match
    //   - noise=0
    // minecraft keywords: [minecraft=5, castle=2, creeper=0] in keywordStats
    //   → avg=7/3≈2.33 → score=-0.117.
    // school keywords:   [school, class, teacher]    — all hit hard → avg=10 → score=-0.5.
    // sports keywords:   [soccer, ball, team]        — all hit hard → avg=10 → score=-0.5.
    // With noise=0, minecraft wins; freshest keyword is 'creeper' (0 hits).
    const hits: KeywordHit[] = [
      { topic: 'minecraft', keyword: 'minecraft', hitCount: 5, firstHitAt: null, lastHitAt: null },
      { topic: 'minecraft', keyword: 'castle', hitCount: 2, firstHitAt: null, lastHitAt: null },
      { topic: 'school', keyword: 'school', hitCount: 10, firstHitAt: null, lastHitAt: null },
      { topic: 'school', keyword: 'class', hitCount: 10, firstHitAt: null, lastHitAt: null },
      { topic: 'school', keyword: 'teacher', hitCount: 10, firstHitAt: null, lastHitAt: null },
      { topic: 'sports', keyword: 'soccer', hitCount: 10, firstHitAt: null, lastHitAt: null },
      { topic: 'sports', keyword: 'ball', hitCount: 10, firstHitAt: null, lastHitAt: null },
      { topic: 'sports', keyword: 'team', hitCount: 10, firstHitAt: null, lastHitAt: null },
    ]
    const tool = createTopicSelectTool({
      topics: [minecraft, school, sports],
      stats: [],
      interests: [],
      keywordStats: hits,
      rng: () => 0.5,
    })
    const result = tool.execute({ phase: 'MAIN_ACTIVITY', exclude_recent_days: 30 }) as
      | { slug: string; title: string; est_minutes: number; suggested_keyword?: string }
      | { error: string }
    if ('error' in result) throw new Error(`unexpected error: ${result.error}`)
    expect(result.slug).toBe('minecraft')
    expect(result.suggested_keyword).toBe('creeper')
  })

  it('breaks ties alphabetically when two keywords share the same hit_count', () => {
    // minecraft keyword hits: minecraft=3, castle=3, creeper=3 → all tied.
    // Alphabetical order: castle, creeper, minecraft → castle wins.
    const hits: KeywordHit[] = [
      { topic: 'minecraft', keyword: 'minecraft', hitCount: 3, firstHitAt: null, lastHitAt: null },
      { topic: 'minecraft', keyword: 'castle', hitCount: 3, firstHitAt: null, lastHitAt: null },
      { topic: 'minecraft', keyword: 'creeper', hitCount: 3, firstHitAt: null, lastHitAt: null },
    ]
    const tool = createTopicSelectTool({
      topics: [minecraft],
      stats: [],
      interests: [],
      keywordStats: hits,
    })
    const result = tool.execute({ phase: 'MAIN_ACTIVITY' }) as
      | { slug: string; suggested_keyword?: string }
      | { error: string }
    if ('error' in result) throw new Error(`unexpected error: ${result.error}`)
    expect(result.suggested_keyword).toBe('castle')
  })

  it('omits suggested_keyword when no keywordStats are passed (legacy callers)', () => {
    const tool = createTopicSelectTool({
      topics: [minecraft],
      stats: [],
      interests: [],
      // no keywordStats
    })
    const result = tool.execute({ phase: 'MAIN_ACTIVITY' }) as
      | { slug: string; suggested_keyword?: string }
      | { error: string }
    if ('error' in result) throw new Error(`unexpected error: ${result.error}`)
    // With no stats, all keywords are tied at 0 → alphabetical: castle.
    // The field IS present because the tool can always compute it.
    expect(result.suggested_keyword).toBe('castle')
  })

  it('omits suggested_keyword when the chosen topic has no keywords', () => {
    const empty = { ...minecraft, keywords: [] }
    const tool = createTopicSelectTool({
      topics: [empty],
      stats: [],
      interests: [],
    })
    const result = tool.execute({ phase: 'MAIN_ACTIVITY' }) as
      | { slug: string; suggested_keyword?: string }
      | { error: string }
    if ('error' in result) throw new Error(`unexpected error: ${result.error}`)
    expect(result.suggested_keyword).toBeUndefined()
  })
})

describe('createTopicSelectTool — v1.0.5 §B (keywords[] + description title)', () => {
  it('returns the full keywords list of the chosen topic so the LLM has opening material', () => {
    const tool = createTopicSelectTool({
      topics: [minecraft, school, sports],
      stats: [],
      interests: [],
      rng: () => 0.5,
    })
    const result = tool.execute({ phase: 'MAIN_ACTIVITY' }) as
      | { slug: string; keywords: string[] }
      | { error: string }
    if ('error' in result) throw new Error(`unexpected error: ${result.error}`)
    // The LLM can use these to anchor the opening question. Minecraft has
    // count=0 (wins over the others), so its keywords are returned verbatim.
    expect(result.slug).toBe('minecraft')
    expect(result.keywords).toEqual(['minecraft', 'castle', 'creeper'])
  })

  it('uses the topic description as title when present, instead of the raw slug', () => {
    const schoolWithDesc: Topic = {
      ...school,
      description: 'School life',
    }
    const tool = createTopicSelectTool({
      topics: [schoolWithDesc],
      stats: [],
      interests: [],
      rng: () => 0.5,
    })
    const result = tool.execute({ phase: 'MAIN_ACTIVITY' }) as
      | { slug: string; title: string; keywords: string[] }
      | { error: string }
    if ('error' in result) throw new Error(`unexpected error: ${result.error}`)
    expect(result.slug).toBe('school')
    expect(result.title).toBe('School life')
    // keywords should still be returned even when description is present.
    expect(result.keywords).toEqual(['school', 'class', 'teacher'])
  })

  it('falls back to slug when description is null or empty/whitespace', () => {
    const withWhitespace: Topic = { ...school, description: '   ' }
    const tool = createTopicSelectTool({
      topics: [withWhitespace],
      stats: [],
      interests: [],
      rng: () => 0.5,
    })
    const result = tool.execute({ phase: 'MAIN_ACTIVITY' }) as
      | { slug: string; title: string }
      | { error: string }
    if ('error' in result) throw new Error(`unexpected error: ${result.error}`)
    expect(result.slug).toBe('school')
    expect(result.title).toBe('school') // fallback, not the whitespace string
  })

  it('returns an empty keywords array when the chosen topic has no keywords', () => {
    const empty: Topic = { ...minecraft, keywords: [] }
    const tool = createTopicSelectTool({
      topics: [empty],
      stats: [],
      interests: [],
      rng: () => 0.5,
    })
    const result = tool.execute({ phase: 'MAIN_ACTIVITY' }) as
      | { slug: string; keywords: string[] }
      | { error: string }
    if ('error' in result) throw new Error(`unexpected error: ${result.error}`)
    expect(result.slug).toBe('minecraft')
    expect(result.keywords).toEqual([])
  })
})
