import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { recordAdoptedTopics } from '../../src/agent/topic-recorder.js'
import { applyMigrations, openDb } from '../../src/storage/db.js'
import {
  createKeywordHitsDao,
  createTopicStatsDao,
  createTopicsDao,
} from '../../src/storage/topics.js'
import type { Topic } from '../../src/storage/topics.js'
import { resolveMigrationsDirForTesting } from '../storage/helpers.js'

const migrationsDir = resolveMigrationsDirForTesting()

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
        ['school_life', { suggestedKeyword: 'homework', source: 'auto' as const }],
        ['food_drink', { suggestedKeyword: 'hotpot', source: 'llm' as const }],
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
        ['school_life', { suggestedKeyword: 'homework', source: 'auto' as const }],
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
        ['school_life', { suggestedKeyword: '', source: 'auto' as const }],
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
        ['school_life', { suggestedKeyword: 'homework', source: 'auto' as const }],
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
      const adopted = new Map<string, { suggestedKeyword: string; source: 'auto' | 'llm' }>()
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
      const adopted = new Map<string, { suggestedKeyword: string; source: 'auto' | 'llm' }>()
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
      const adopted = new Map<string, { suggestedKeyword: string; source: 'auto' | 'llm' }>()
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
        ['school_life', { suggestedKeyword: 'homework', source: 'auto' as const }],
        ['food_drink', { suggestedKeyword: 'hotpot', source: 'llm' as const }],
        ['daily_routine', { suggestedKeyword: 'morning', source: 'llm' as const }],
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
})