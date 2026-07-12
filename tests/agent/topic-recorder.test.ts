import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ADOPTION_MIN_TURNS, recordAdoptedTopics } from '../../src/agent/topic-recorder.js'
import { applyMigrations, openDb } from '../../src/storage/db.js'
import {
  createKeywordHitsDao,
  createTopicStatsDao,
  createTopicsDao,
} from '../../src/storage/topics.js'
import type { Topic } from '../../src/storage/topics.js'
import { resolveMigrationsDirForTesting } from '../storage/helpers.js'

const migrationsDir = resolveMigrationsDirForTesting()

// v1.0.9 §1.4 — helper to build a "definitely adopted" ledger entry.
// Existing tests of the write path don't exercise the threshold gate;
// they just want to confirm recordAdoptedTopics increments correctly.
// Pass any onTopicTurns ≥ ADOPTION_MIN_TURNS.
const ABOVE = ADOPTION_MIN_TURNS + 1
const adoptedEntry = (
  suggestedKeyword: string,
  source: 'auto' | 'llm',
  topic: Topic,
  onTopicTurns = ABOVE,
) => ({
  suggestedKeyword,
  source,
  onTopicTurns,
  keywords: topic.keywords,
  description: topic.description,
})

// Fixture topics — small library so we can assert exact increments.
const TOPICS: Topic[] = [
  {
    name: 'school_life',
    keywords: ['school', 'class', 'teacher', 'homework'],
    description: 'School life',
    createdAt: '2026-07-01T00:00:00.000Z',
  },
  {
    name: 'food_drink',
    keywords: ['food', 'drink', 'restaurant', 'hotpot'],
    description: 'Food and drink',
    createdAt: '2026-07-01T00:00:00.000Z',
  },
  {
    name: 'daily_routine',
    keywords: ['morning', 'breakfast', 'commute', 'work'],
    description: 'Daily routine',
    createdAt: '2026-07-01T00:00:00.000Z',
  },
]

describe('recordAdoptedTopics (v1.0.7 §11)', () => {
  let dir: string
  let db: ReturnType<typeof openDb>
  let topicStats: ReturnType<typeof createTopicStatsDao>
  let keywordHits: ReturnType<typeof createKeywordHitsDao>
  let topicsDao: ReturnType<typeof createTopicsDao>
  const now = new Date('2026-07-08T10:00:00.000Z')

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'topic-recorder-test-'))
    db = openDb({ dataDir: dir })
    applyMigrations(db, migrationsDir)
    topicStats = createTopicStatsDao(db)
    keywordHits = createKeywordHitsDao(db)
    topicsDao = createTopicsDao(db)
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  describe('happy path (non-empty adopted ledger)', () => {
    it('writes one topic_stats row per adopted slug and returns the slug list', () => {
      const adopted = new Map([
        ['school_life', adoptedEntry('homework', 'auto', TOPICS[0]!)],
        ['food_drink', adoptedEntry('hotpot', 'llm', TOPICS[1]!)],
      ])
      const result = recordAdoptedTopics(
        adopted,
        ['ignored', 'fallback', 'keywords'],
        { sessionId: 'sess-1', now },
        { topics: TOPICS, topicStats, keywordHits, topicsDao },
      )
      expect(result).toEqual(['school_life', 'food_drink'])

      const school = topicStats.get('school_life')
      expect(school?.discussionCount).toBe(1)
      expect(school?.lastDiscussedAt).toBe(now.toISOString())

      const food = topicStats.get('food_drink')
      expect(food?.discussionCount).toBe(1)
    })

    it('writes one keyword_hits row per adopted slug with the suggested keyword', () => {
      const adopted = new Map([
        ['school_life', adoptedEntry('homework', 'auto', TOPICS[0]!)],
      ])
      recordAdoptedTopics(
        adopted,
        [],
        { sessionId: 'sess-1', now },
        { topics: TOPICS, topicStats, keywordHits, topicsDao },
      )
      const hits = keywordHits.getByTopic('school_life')
      expect(hits).toHaveLength(1)
      expect(hits[0]?.keyword).toBe('homework')
      expect(hits[0]?.hitCount).toBe(1)
    })

    it('handles empty suggestedKeyword by skipping keyword_hits but still incrementing topic_stats', () => {
      const adopted = new Map([
        ['school_life', adoptedEntry('', 'auto', TOPICS[0]!)],
      ])
      const result = recordAdoptedTopics(
        adopted,
        [],
        { sessionId: 'sess-1', now },
        { topics: TOPICS, topicStats, keywordHits, topicsDao },
      )
      expect(result).toEqual(['school_life'])
      expect(topicStats.get('school_life')?.discussionCount).toBe(1)
      expect(keywordHits.getAll()).toHaveLength(0)
    })
  })

  describe('dedup by slug', () => {
    it('Map keys ensure each slug is incremented exactly once even if set twice upstream', () => {
      // Map dedup is by key, so callers cannot insert duplicates — but
      // verify the function only emits one incrementAndUpdate per slug.
      const adopted = new Map([
        ['school_life', adoptedEntry('homework', 'auto', TOPICS[0]!)],
      ])
      recordAdoptedTopics(
        adopted,
        [],
        { sessionId: 'sess-1', now },
        { topics: TOPICS, topicStats, keywordHits, topicsDao },
      )
      // Second call with same slug should increment count again — that's
      // the design: each session increments once, but cross-session we
      // want to accumulate.
      recordAdoptedTopics(
        adopted,
        [],
        { sessionId: 'sess-2', now },
        { topics: TOPICS, topicStats, keywordHits, topicsDao },
      )
      expect(topicStats.get('school_life')?.discussionCount).toBe(2)
    })
  })

  describe('fallback path (empty adopted ledger)', () => {
    it('falls back to matchTopic when adopted is empty and summary has overlapping keywords', () => {
      const adopted = new Map<string, ReturnType<typeof adoptedEntry>>()
      // 'hotpot' is in food_drink — matchTopic should find it.
      const result = recordAdoptedTopics(
        adopted,
        ['hotpot', 'spicy', 'friends'],
        { sessionId: 'sess-1', now },
        { topics: TOPICS, topicStats, keywordHits, topicsDao },
      )
      expect(result).toEqual(['food_drink'])
      expect(topicStats.get('food_drink')?.discussionCount).toBe(1)
      const hits = keywordHits.getByTopic('food_drink')
      // Should write the SHARED keywords only (not the full input array).
      expect(hits.map((h) => h.keyword)).toEqual(['hotpot'])
    })

    it('returns empty array when fallback also finds nothing', () => {
      const adopted = new Map<string, ReturnType<typeof adoptedEntry>>()
      const result = recordAdoptedTopics(
        adopted,
        ['totally', 'unrelated', 'words'],
        { sessionId: 'sess-1', now },
        { topics: TOPICS, topicStats, keywordHits, topicsDao },
      )
      expect(result).toEqual([])
      expect(topicStats.all()).toHaveLength(0)
      expect(keywordHits.getAll()).toHaveLength(0)
    })

    it('returns empty array when adopted is empty AND fallback keywords are empty', () => {
      const adopted = new Map<string, ReturnType<typeof adoptedEntry>>()
      const result = recordAdoptedTopics(
        adopted,
        [],
        { sessionId: 'sess-1', now },
        { topics: TOPICS, topicStats, keywordHits, topicsDao },
      )
      expect(result).toEqual([])
    })
  })

  describe('integration with multiple adopted slugs', () => {
    it('three adopted slugs → three topic_stats rows + three keyword_hits entries', () => {
      const adopted = new Map([
        ['school_life', adoptedEntry('homework', 'auto', TOPICS[0]!)],
        ['food_drink', adoptedEntry('hotpot', 'llm', TOPICS[1]!)],
        ['daily_routine', adoptedEntry('morning', 'llm', TOPICS[2]!)],
      ])
      const result = recordAdoptedTopics(
        adopted,
        [],
        { sessionId: 'sess-1', now },
        { topics: TOPICS, topicStats, keywordHits, topicsDao },
      )
      expect(result).toHaveLength(3)
      expect(result).toContain('school_life')
      expect(result).toContain('food_drink')
      expect(result).toContain('daily_routine')

      expect(topicStats.all().map((s) => s.topic).sort()).toEqual([
        'daily_routine',
        'food_drink',
        'school_life',
      ])
      expect(keywordHits.getAll()).toHaveLength(3)
    })
  })

  describe('v1.0.9 §1.4 — write-on-adoption (onTopicTurns threshold)', () => {
    it('drops adopted entries below ADOPTION_MIN_TURNS, falls back to matchTopic', () => {
      // Both adopted entries are below threshold. recordAdoptedTopics
      // should skip them and fall back to matchTopic on the summary keywords.
      // 'hotpot' is in food_drink — matchTopic finds it.
      const adopted = new Map([
        ['school_life', adoptedEntry('homework', 'auto', TOPICS[0]!, ADOPTION_MIN_TURNS - 1)],
        ['food_drink', adoptedEntry('hotpot', 'llm', TOPICS[1]!, 0)],
      ])
      const result = recordAdoptedTopics(
        adopted,
        ['hotpot', 'spicy', 'friends'],
        { sessionId: 'sess-1', now },
        { topics: TOPICS, topicStats, keywordHits, topicsDao },
      )
      expect(result).toEqual(['food_drink']) // from matchTopic fallback
      // Only food_drink counted (from fallback); school_life was below threshold.
      expect(topicStats.get('school_life')).toBeNull()
      expect(topicStats.get('food_drink')?.discussionCount).toBe(1)
    })

    it('counts entries at-or-above ADOPTION_MIN_TURNS; below are silently dropped', () => {
      const adopted = new Map([
        ['school_life', adoptedEntry('homework', 'auto', TOPICS[0]!, ADOPTION_MIN_TURNS)], // boundary
        ['food_drink', adoptedEntry('hotpot', 'llm', TOPICS[1]!, ADOPTION_MIN_TURNS - 1)], // one below
      ])
      const result = recordAdoptedTopics(
        adopted,
        [],
        { sessionId: 'sess-1', now },
        { topics: TOPICS, topicStats, keywordHits, topicsDao },
      )
      expect(result).toEqual(['school_life'])
      expect(topicStats.get('school_life')?.discussionCount).toBe(1)
      expect(topicStats.get('food_drink')).toBeNull()
    })

    it('counts all entries when every entry is above threshold (happy mix)', () => {
      const adopted = new Map([
        ['school_life', adoptedEntry('homework', 'auto', TOPICS[0]!, 5)],
        ['food_drink', adoptedEntry('hotpot', 'llm', TOPICS[1]!, 3)],
      ])
      const result = recordAdoptedTopics(
        adopted,
        ['unrelated'],
        { sessionId: 'sess-1', now },
        { topics: TOPICS, topicStats, keywordHits, topicsDao },
      )
      expect(result).toHaveLength(2)
      expect(topicStats.get('school_life')?.discussionCount).toBe(1)
      expect(topicStats.get('food_drink')?.discussionCount).toBe(1)
    })

    it('falls back to matchTopic when ALL adopted entries are below threshold', () => {
      const adopted = new Map([
        ['school_life', adoptedEntry('homework', 'auto', TOPICS[0]!, 0)],
      ])
      const result = recordAdoptedTopics(
        adopted,
        ['hotpot', 'friends'],
        { sessionId: 'sess-1', now },
        { topics: TOPICS, topicStats, keywordHits, topicsDao },
      )
      expect(result).toEqual(['food_drink'])
      expect(topicStats.get('school_life')).toBeNull()
      expect(topicStats.get('food_drink')?.discussionCount).toBe(1)
    })
  })
})