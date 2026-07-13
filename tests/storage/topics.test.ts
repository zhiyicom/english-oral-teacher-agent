import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyMigrations, openDb } from '../../src/storage/db.js'
import {
  type TopicStatsDao,
  type TopicsDao,
  createTopicStatsDao,
  createTopicsDao,
} from '../../src/storage/topics.js'
import { resolveMigrationsDirForTesting } from './helpers.js'

const migrationsDir = resolveMigrationsDirForTesting()

describe('TopicsDao + TopicStatsDao (v1.0.5 §C migrations 003 + 007)', () => {
  let dir: string
  let db: ReturnType<typeof openDb>
  let topics: TopicsDao
  let stats: TopicStatsDao

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'topics-test-'))
    db = openDb({ dataDir: dir })
    applyMigrations(db, migrationsDir)
    topics = createTopicsDao(db)
    stats = createTopicStatsDao(db)
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  describe('seed data (v1.0.5 §C: 003 CREATE TABLE only, 007 seeds 34)', () => {
    it('migration 007 seeds 34 baseline topics', () => {
      const all = topics.list()
      expect(all).toHaveLength(34)
      const names = all.map((t) => t.name).sort()
      // Spot-check a few well-known baseline names instead of asserting all 34
      expect(names).toContain('art_culture')
      expect(names).toContain('food_drink')
      expect(names).toContain('school_life')
      expect(names).toContain('travel')
      // v1.0.9 added: aviation / gaming / music / space_science
      expect(names).toContain('aviation')
      expect(names).toContain('gaming')
      expect(names).toContain('music')
      expect(names).toContain('space_science')
      // v0.6 names are NOT seeded anymore (003 removed them; 007 has no overlap)
      expect(names).not.toContain('movies')
    })

    it('topics have non-empty keyword arrays', () => {
      for (const t of topics.list()) {
        expect(t.keywords.length).toBeGreaterThanOrEqual(3)
        for (const k of t.keywords) {
          expect(typeof k).toBe('string')
          expect(k.length).toBeGreaterThan(0)
        }
      }
    })

    it('food_drink topic keywords include the breakfast keyword', () => {
      const fd = topics.get('food_drink')
      expect(fd).not.toBeNull()
      const kw = fd?.keywords ?? []
      expect(kw).toContain('food')
      expect(kw).toContain('breakfast')
    })

    it('get(name) returns single topic or null', () => {
      const fd = topics.get('food_drink')
      expect(fd?.name).toBe('food_drink')
      const missing = topics.get('does-not-exist')
      expect(missing).toBeNull()
    })
  })

  describe('TopicsDao.create() (v1.1.0 §1.2)', () => {
    it('T1: inserts a new topic and returns true', () => {
      const before = topics.list().length
      const ok = topics.create({
        name: 'ceramics',
        keywords: ['pottery', 'ceramics', 'kiln', 'glaze', 'clay'],
        description: 'Ceramics & pottery — making, firing, glazing (A2-B1)',
        createdAt: '2026-07-13T10:00:00.000Z',
      })
      expect(ok).toBe(true)
      expect(topics.list()).toHaveLength(before + 1)
      const row = topics.get('ceramics')
      expect(row).not.toBeNull()
      expect(row?.keywords).toEqual(['pottery', 'ceramics', 'kiln', 'glaze', 'clay'])
      expect(row?.description).toBe('Ceramics & pottery — making, firing, glazing (A2-B1)')
    })

    it('T2: duplicate name returns false and does not mutate DB (OR IGNORE)', () => {
      const before = topics.list().length
      const originalFoodDrink = topics.get('food_drink')
      // Attempt to overwrite food_drink with different keywords — must be
      // silently rejected by OR IGNORE, baseline keywords preserved.
      const ok = topics.create({
        name: 'food_drink',
        keywords: ['totally', 'different'],
        description: 'should not stick',
        createdAt: '2026-07-13T10:00:00.000Z',
      })
      expect(ok).toBe(false)
      expect(topics.list()).toHaveLength(before)
      const after = topics.get('food_drink')
      expect(after?.keywords).toEqual(originalFoodDrink?.keywords)
      expect(after?.description).toBe(originalFoodDrink?.description)
    })
  })

  describe('TopicStatsDao', () => {
    it('get returns null for never-discussed topic', () => {
      expect(stats.get('food_drink')).toBeNull()
    })

    it('all() returns empty array before any session', () => {
      expect(stats.all()).toEqual([])
    })

    it('incrementAndUpdate on a fresh topic: INSERT count=1 with first/last = now', () => {
      const now = new Date('2026-06-09T10:00:00.000Z')
      stats.incrementAndUpdate('food_drink', now)
      const row = stats.get('food_drink')
      expect(row).toEqual({
        topic: 'food_drink',
        discussionCount: 1,
        firstDiscussedAt: '2026-06-09T10:00:00.000Z',
        lastDiscussedAt: '2026-06-09T10:00:00.000Z',
      })
    })

    it('incrementAndUpdate on existing topic: count++, last updates, first unchanged', () => {
      const t1 = new Date('2026-06-09T10:00:00.000Z')
      const t2 = new Date('2026-06-09T11:30:00.000Z')
      stats.incrementAndUpdate('food_drink', t1)
      stats.incrementAndUpdate('food_drink', t2)
      const row = stats.get('food_drink')
      expect(row?.discussionCount).toBe(2)
      expect(row?.firstDiscussedAt).toBe('2026-06-09T10:00:00.000Z') // unchanged
      expect(row?.lastDiscussedAt).toBe('2026-06-09T11:30:00.000Z') // updated
    })

    it('all() orders by last_discussed_at DESC, then topic ASC', () => {
      // 3 baseline topics: food_drink most recent, travel oldest
      stats.incrementAndUpdate('travel', new Date('2026-06-08T10:00:00.000Z'))
      stats.incrementAndUpdate('food_drink', new Date('2026-06-09T11:00:00.000Z'))
      stats.incrementAndUpdate('school_life', new Date('2026-06-09T10:00:00.000Z'))
      const all = stats.all()
      expect(all.map((s) => s.topic)).toEqual(['food_drink', 'school_life', 'travel'])
    })
  })
})
