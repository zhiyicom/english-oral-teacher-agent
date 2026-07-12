import { describe, expect, it } from 'vitest'
import {
  avgKeywordHit,
  computeContextOverlap,
  computeInterest,
  filterHardExclude,
  isTurnOnTopic,
  selectTopic,
  sortByCountAsc,
} from '../../src/agent/topic-engine.js'
import type { KeywordHit, Topic, TopicStat } from '../../src/storage/topics.js'

const NOW = new Date('2026-06-10T12:00:00.000Z')
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
const food = topic('food', ['pizza', 'burger', 'noodle'])

describe('filterHardExclude (D1)', () => {
  it('keeps topics never discussed (no stat row)', () => {
    const pool = [minecraft, school, sports]
    const stats: TopicStat[] = []
    expect(filterHardExclude(pool, stats, 30, NOW)).toEqual(pool)
  })

  it('drops topics discussed within the cutoff window', () => {
    // minecraft was discussed 5 days ago, excludeDays=30 → within window → drop.
    // school was discussed 60 days ago → outside window → keep.
    const stats = [stat('minecraft', 3, 5), stat('school', 2, 60)]
    const pool = [minecraft, school, sports]
    const result = filterHardExclude(pool, stats, 30, NOW)
    expect(result).toEqual([school, sports])
  })

  it('cutoff boundary: discussed exactly 30 days ago is still inside the window', () => {
    // 30 days ago == cutoff (now - 30*DAY). cutoff is exclusive in `>`,
    // so the boundary topic is dropped.
    const stats = [stat('school', 1, 30)]
    const result = filterHardExclude([minecraft, school], stats, 30, NOW)
    expect(result).toEqual([minecraft])
  })
})

describe('sortByCountAsc (D2)', () => {
  it('sorts topics by discussionCount ascending, alphabetical tiebreak', () => {
    // food: 0, sports: 1, minecraft: 3, school: 3 (tie with minecraft → school first)
    const pool = [minecraft, school, sports, food]
    const stats = [stat('minecraft', 3, 5), stat('school', 3, 10), stat('sports', 1, 20)]
    const result = sortByCountAsc(pool, stats).map((t) => t.name)
    // tiebreaker is `a.name.localeCompare(b.name)` → 'minecraft' < 'school'
    expect(result).toEqual(['food', 'sports', 'minecraft', 'school'])
  })

  it('topics with no stat row are treated as count=0 (sink to front)', () => {
    const pool = [minecraft, school, food]
    const stats = [stat('minecraft', 5, 10)]
    const result = sortByCountAsc(pool, stats).map((t) => t.name)
    expect(result).toEqual(['food', 'school', 'minecraft'])
  })
})

describe('computeInterest (D3)', () => {
  it('returns the case-insensitive keyword overlap count', () => {
    // interests = ['Minecraft', 'castle']. minecraft keywords = [minecraft, castle, creeper]. Overlap = 2.
    expect(computeInterest(minecraft, ['Minecraft', 'castle'])).toBe(2)
    expect(computeInterest(minecraft, ['minecraft', 'castle', 'creeper'])).toBe(3)
  })

  it('empty interests → 0', () => {
    expect(computeInterest(minecraft, [])).toBe(0)
  })
})

describe('selectTopic (D1+D2+D3+D4 top-level)', () => {
  it('pool empty after hard exclude → null', () => {
    // all 3 topics discussed within the 30-day window
    const stats = [stat('minecraft', 1, 5), stat('school', 1, 10), stat('sports', 1, 20)]
    expect(
      selectTopic({ topics: [minecraft, school, sports], stats, interests: [], now: NOW }),
    ).toBeNull()
  })

  it('deterministic with rng stub: noise=0 picks the highest base score', () => {
    // food: count=0, interest=0 → score = 0
    // sports: count=5, interest=0 → score = -0.5
    // With rng=()=>0.5 → noise=0, food wins.
    const stats = [stat('sports', 5, 100)]
    const result = selectTopic({
      topics: [minecraft, school, sports, food],
      stats,
      interests: [],
      rng: () => 0.5, // noise = (0.5*2-1)*0.2 = 0
      now: NOW,
    })
    expect(result?.name).toBe('food')
  })

  it('interest boost overrides low count: a topic with interest 2 beats one with no interest even with slightly higher count', () => {
    // food: count=0, interest=0 (none in interests) → score = 0
    // minecraft: count=1, interest=2 (matches 'minecraft', 'castle') → score = -0.1 + 1.0 = 0.9
    // rng=0.5 → noise=0. minecraft wins by a lot.
    // v1.0.3 §1.3 — opt back into D3 explicitly; default useInterestBoost is now false.
    const stats = [stat('food', 0, 100), stat('minecraft', 1, 100)]
    const result = selectTopic({
      topics: [minecraft, school, food],
      stats,
      interests: ['minecraft', 'castle'],
      rng: () => 0.5,
      now: NOW,
      useInterestBoost: true,
    })
    expect(result?.name).toBe('minecraft')
  })

  it('weighted random: noise breaks ties when rng gives different values per topic', () => {
    // food vs school: both count=0, interest=0. Score differs only by noise (±0.2).
    // map() iterates in pool order [food, school], so the rng is called once
    // per topic. With rng=[0, 1]: food noise=-0.2, school noise=+0.2 → school wins.
    // With rng=[1, 0]: food noise=+0.2, school noise=-0.2 → food wins.
    // This proves the noise term takes effect across topics in a single
    // selectTopic() call (not just across multiple invocations).
    const stats: TopicStat[] = [stat('food', 0, 100), stat('school', 0, 100)]
    let n1 = 0
    const r1 = selectTopic({
      topics: [food, school],
      stats,
      interests: [],
      rng: () => [0, 1][n1++] as number,
      now: NOW,
    })
    let n2 = 0
    const r2 = selectTopic({
      topics: [food, school],
      stats,
      interests: [],
      rng: () => [1, 0][n2++] as number,
      now: NOW,
    })
    expect(r1?.name).toBe('school')
    expect(r2?.name).toBe('food')
  })
})

describe('avgKeywordHit (D5 helper)', () => {
  it('returns mean hit_count across the topic keywords', () => {
    // minecraft keywords: minecraft=5, castle=2, creeper=0 (missing)
    // mean = (5 + 2 + 0) / 3 = 2.333...
    const hits: KeywordHit[] = [
      { topic: 'minecraft', keyword: 'minecraft', hitCount: 5, firstHitAt: null, lastHitAt: null },
      { topic: 'minecraft', keyword: 'castle', hitCount: 2, firstHitAt: null, lastHitAt: null },
    ]
    expect(avgKeywordHit(minecraft, hits)).toBeCloseTo(7 / 3, 5)
  })

  it('keywords missing from stats are treated as 0', () => {
    // school keywords: school, class, teacher — none in stats → avg = 0.
    expect(avgKeywordHit(school, [])).toBe(0)
  })

  it('empty topic.keywords → 0 (no penalty, no bonus)', () => {
    const empty = topic('empty', [])
    expect(avgKeywordHit(empty, [])).toBe(0)
  })

  it('keyword lookup is case-insensitive', () => {
    // stats row stores 'Minecraft', topic.keywords stores 'minecraft' → same.
    const hits: KeywordHit[] = [
      { topic: 'minecraft', keyword: 'MINECRAFT', hitCount: 4, firstHitAt: null, lastHitAt: null },
    ]
    expect(avgKeywordHit(minecraft, hits)).toBeCloseTo(4 / 3, 5)
  })
})

describe('selectTopic D5 — keyword freshness bias (v1.0.2)', () => {
  it('two topics with equal count + interest: lower avgKeywordHit wins', () => {
    // minecraft: count=1, interest=0, avg=2 (keywords hit hard)
    //   score = -0.1 + 0 - 2*0.05 + 0 + 0 = -0.2
    // school:   count=1, interest=0, avg=0 (no keyword hits)
    //   score = -0.1 + 0 - 0      + 0 + 0 = -0.1
    // With rng=0.5 (noise=0), school wins.
    const stats: TopicStat[] = [stat('minecraft', 1, 100), stat('school', 1, 100)]
    const hits: KeywordHit[] = [
      { topic: 'minecraft', keyword: 'minecraft', hitCount: 2, firstHitAt: null, lastHitAt: null },
      { topic: 'minecraft', keyword: 'castle', hitCount: 2, firstHitAt: null, lastHitAt: null },
      { topic: 'minecraft', keyword: 'creeper', hitCount: 2, firstHitAt: null, lastHitAt: null },
    ]
    const result = selectTopic({
      topics: [minecraft, school],
      stats,
      interests: [],
      keywordStats: hits,
      rng: () => 0.5,
      now: NOW,
    })
    expect(result?.name).toBe('school')
  })

  it('omitting keywordStats preserves the v0.7.6 contract (no D5 penalty)', () => {
    // Regression: callers that don't pass keywordStats should still get the
    // old behavior. food (count=0) beats sports (count=5) just like before.
    const stats: TopicStat[] = [stat('sports', 5, 100)]
    const result = selectTopic({
      topics: [minecraft, school, sports, food],
      stats,
      interests: [],
      rng: () => 0.5,
      now: NOW,
    })
    expect(result?.name).toBe('food')
  })

  it('keyword freshness cannot override interest boost (W_KEYWORD < W_INTEREST)', () => {
    // minecraft: count=0, interest=2 → +1.0; avg=10 → -0.5
    //   score = 0 + 1.0 - 0.5 + 0 = 0.5
    // food: count=0, interest=0 → 0; avg=0 → 0
    //   score = 0 + 0 + 0 + 0 = 0
    // interest boost is still strong enough to keep minecraft on top.
    // v1.0.3 §1.3 — must opt back into D3 explicitly to test legacy scoring.
    const stats: TopicStat[] = []
    const hits: KeywordHit[] = [
      { topic: 'minecraft', keyword: 'minecraft', hitCount: 10, firstHitAt: null, lastHitAt: null },
      { topic: 'minecraft', keyword: 'castle', hitCount: 10, firstHitAt: null, lastHitAt: null },
      { topic: 'minecraft', keyword: 'creeper', hitCount: 10, firstHitAt: null, lastHitAt: null },
    ]
    const result = selectTopic({
      topics: [minecraft, food],
      stats,
      interests: ['minecraft', 'castle'],
      keywordStats: hits,
      rng: () => 0.5,
      now: NOW,
      useInterestBoost: true,
    })
    expect(result?.name).toBe('minecraft')
  })
})

describe('selectTopic v1.0.3 §1.3 — useInterestBoost flag', () => {
  it('default (false) ignores interests even when non-empty', () => {
    // minecraft: count=0, interest (would-be) =2 → +1.0
    // food:      count=0, interest =0 → 0
    // Without useInterestBoost, minecraft's interest is 0 → food wins on count tie.
    const stats: TopicStat[] = []
    const result = selectTopic({
      topics: [minecraft, food],
      stats,
      interests: ['minecraft', 'castle'],
      rng: () => 0.5,
      now: NOW,
    })
    // Both have count=0; tie broken alphabetically → 'food' < 'minecraft' → food.
    expect(result?.name).toBe('food')
  })

  it('explicit useInterestBoost:false still ignores interests', () => {
    const stats: TopicStat[] = []
    const result = selectTopic({
      topics: [minecraft, food],
      stats,
      interests: ['minecraft', 'castle'],
      useInterestBoost: false,
      rng: () => 0.5,
      now: NOW,
    })
    expect(result?.name).toBe('food')
  })

  it('useInterestBoost:true preserves legacy D3 behavior', () => {
    // minecraft: count=0, interest=2 → +1.0; food: count=0, interest=0 → 0
    // minecraft wins.
    const stats: TopicStat[] = []
    const result = selectTopic({
      topics: [minecraft, food],
      stats,
      interests: ['minecraft', 'castle'],
      useInterestBoost: true,
      rng: () => 0.5,
      now: NOW,
    })
    expect(result?.name).toBe('minecraft')
  })

  it('useInterestBoost:false with matching interests does NOT change score on count ties', () => {
    // Same setup as the legacy "interest boost overrides low count" test above
    // but with useInterestBoost:false. food should win instead of minecraft.
    const stats: TopicStat[] = [stat('food', 0, 100), stat('minecraft', 1, 100)]
    const result = selectTopic({
      topics: [minecraft, school, food],
      stats,
      interests: ['minecraft', 'castle'],
      useInterestBoost: false,
      rng: () => 0.5,
      now: NOW,
    })
    // food count=0, minecraft count=1. D2 sort → food first → wins on tie.
    expect(result?.name).toBe('food')
  })
})

describe('selectTopic v1.0.9 §1.2 — NOISE_RANGE=0.05', () => {
  it('peak noise cannot flip a 3-count gap (count=0 stays on top)', () => {
    // food: count=0 → base score 0
    // sports: count=3 → base score -0.3
    // Gap = 0.3. With NOISE_RANGE=0.05, peak noise (±0.05) cannot flip it.
    // Even under the most adversarial rng:
    //   food rng=1 (noise=+0.05) vs sports rng=0 (noise=-0.05)
    //   food=0+0.05=0.05, sports=-0.3-0.05=-0.35 → food still wins by 0.4
    const stats: TopicStat[] = [stat('sports', 3, 100)]
    let n = 0
    const result = selectTopic({
      topics: [food, sports],
      stats,
      interests: [],
      rng: () => [1, 0][n++] as number, // max swing against food
      now: NOW,
    })
    expect(result?.name).toBe('food')
  })

  it('peak noise can still break a 0-count tie (regression: D4 still works)', () => {
    // food vs school: both count=0, base score 0. Noise (peak ±0.05) breaks tie.
    // rng=[0, 1]: food=-0.05, school=+0.05 → school wins.
    const stats: TopicStat[] = [stat('food', 0, 100), stat('school', 0, 100)]
    let n = 0
    const result = selectTopic({
      topics: [food, school],
      stats,
      interests: [],
      rng: () => [0, 1][n++] as number,
      now: NOW,
    })
    expect(result?.name).toBe('school')
  })
})

describe('isTurnOnTopic (v1.0.9 §1.4)', () => {
  const boeing: Topic = {
    name: 'boeing_737',
    keywords: ['boeing', '737', 'cockpit'],
    description: '波音 737 驾驶舱',
    createdAt: '2026-06-01T00:00:00.000Z',
  }

  it('returns true when user message contains a topic keyword', () => {
    expect(isTurnOnTopic(boeing, 'I watched a Boeing cockpit video', '')).toBe(true)
  })

  it('returns true when assistant message contains a topic keyword', () => {
    // User said "ok" — no keyword; assistant responds "the cockpit has three displays" → match.
    expect(isTurnOnTopic(boeing, 'ok', 'Anyway, the cockpit has three displays.')).toBe(true)
  })

  it('returns false when neither side contains any keyword or description', () => {
    expect(isTurnOnTopic(boeing, '嗯', 'Tell me more.')).toBe(false)
    expect(isTurnOnTopic(boeing, 'yeah', 'Got it. What do you want to do today?')).toBe(false)
  })

  it('description (long Chinese form) acts as substring needle for fallback', () => {
    // No exact English keyword match — but "波音 737 驾驶舱" substring matches.
    expect(isTurnOnTopic(boeing, '我昨天看了波音 737 的视频', '哦？')).toBe(true)
  })

  it('matching is case-insensitive', () => {
    expect(isTurnOnTopic(boeing, 'I saw a BOEING 737', '')).toBe(true)
    expect(isTurnOnTopic(boeing, 'cockpit COCKPIT cockpit', '')).toBe(true)
  })

  it('returns false for topic with empty keywords and null description', () => {
    const empty: Topic = {
      name: 'empty',
      keywords: [],
      description: null,
      createdAt: '2026-06-01T00:00:00.000Z',
    }
    expect(isTurnOnTopic(empty, 'anything', 'goes')).toBe(false)
  })

  it('returns false when keywords are whitespace-only after trim', () => {
    const ws: Topic = {
      name: 'ws',
      keywords: ['   ', '  '],
      description: null,
      createdAt: '2026-06-01T00:00:00.000Z',
    }
    expect(isTurnOnTopic(ws, 'anything', 'goes')).toBe(false)
  })
})

describe('computeContextOverlap (v1.0.9 §1.3)', () => {
  it('returns case-insensitive keyword overlap count', () => {
    // minecraft keywords = [minecraft, castle, creeper]. context = [Minecraft, Castle].
    expect(computeContextOverlap(minecraft, ['Minecraft', 'Castle'])).toBe(2)
  })

  it('returns 0 when contextKeywords is empty', () => {
    expect(computeContextOverlap(minecraft, [])).toBe(0)
  })

  it('returns 0 when topic.keywords is empty', () => {
    const empty = topic('empty', [])
    expect(computeContextOverlap(empty, ['anything'])).toBe(0)
  })

  it('returns 0 when no overlap', () => {
    expect(computeContextOverlap(minecraft, ['football', 'stadium'])).toBe(0)
  })
})

describe('selectTopic v1.0.9 §1.3 — contextKeywords boost', () => {
  // Two topics with equal count and zero keyword hits. minecraft has 2 of its
  // keywords in the WARM_UP context; food has none. CONTEXT_WEIGHT=0.15 so
  // minecraft picks up +0.30 of boost, beating food on a count tie.
  it('context-matching topic wins over same-count non-matching (rng=0.5)', () => {
    const stats: TopicStat[] = []
    const result = selectTopic({
      topics: [minecraft, food],
      stats,
      interests: [],
      contextKeywords: ['minecraft', 'castle'], // matches minecraft twice
      rng: () => 0.5,
      now: NOW,
    })
    expect(result?.name).toBe('minecraft')
  })

  it('dedup priority beats relevance: recently-discussed related topic is still D1-excluded', () => {
    // minecraft matches WARM_UP context (strong boost), but was discussed
    // 5 days ago → D1 with excludeDays=30 drops it. food has no boost but
    // survived D1 → food wins. This proves contextBoost cannot bring a
    // recently-discussed topic back into the pool.
    const stats: TopicStat[] = [stat('minecraft', 1, 5)]
    const result = selectTopic({
      topics: [minecraft, food],
      stats,
      interests: [],
      excludeDays: 30,
      contextKeywords: ['minecraft', 'castle', 'creeper'], // 3/3 match → +0.45
      rng: () => 0.5,
      now: NOW,
    })
    expect(result?.name).toBe('food')
  })

  it('single-keyword context boost beats a 1-count difference', () => {
    // minecraft: count=0, context=1 (minecraft) → +0.15 boost → score = +0.15
    // sports:   count=1, context=0                → score = -0.10
    // Without context: sports would win (-0.10 > +0). With context: minecraft wins.
    const stats: TopicStat[] = [stat('sports', 1, 100)]
    const result = selectTopic({
      topics: [minecraft, sports],
      stats,
      interests: [],
      contextKeywords: ['minecraft'],
      rng: () => 0.5,
      now: NOW,
    })
    expect(result?.name).toBe('minecraft')
  })

  it('contextKeywords omitted → no boost (legacy behavior preserved)', () => {
    // Same setup as the count-tie test from the main describe block, but
    // with contextKeywords undefined. food still wins on count=0.
    const stats: TopicStat[] = [stat('sports', 5, 100)]
    const result = selectTopic({
      topics: [minecraft, school, sports, food],
      stats,
      interests: [],
      rng: () => 0.5,
      now: NOW,
    })
    expect(result?.name).toBe('food')
  })

  it('empty contextKeywords array → no boost (treated same as omitted)', () => {
    // Defense: [] must produce 0 overlap, not throw or score-empty-pool.
    const stats: TopicStat[] = [stat('sports', 5, 100)]
    const result = selectTopic({
      topics: [minecraft, school, sports, food],
      stats,
      interests: [],
      contextKeywords: [],
      rng: () => 0.5,
      now: NOW,
    })
    expect(result?.name).toBe('food')
  })
})
