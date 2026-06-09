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

describe('TopicsDao + TopicStatsDao (v0.6 migration 003)', () => {
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

  describe('seed data', () => {
    it('migration 003 populates 7 starter topics', () => {
      const all = topics.list()
      expect(all).toHaveLength(7)
      const names = all.map((t) => t.name).sort()
      expect(names).toEqual(['family', 'food', 'minecraft', 'movies', 'music', 'school', 'sports'])
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

    it('minecraft topic keywords include the v0.5 fixture keywords', () => {
      const mc = topics.get('minecraft')
      expect(mc).not.toBeNull()
      const kw = mc?.keywords ?? []
      expect(kw).toContain('minecraft')
      expect(kw).toContain('castle')
      expect(kw).toContain('creeper')
    })

    it('get(name) returns single topic or null', () => {
      const mc = topics.get('minecraft')
      expect(mc?.name).toBe('minecraft')
      const missing = topics.get('does-not-exist')
      expect(missing).toBeNull()
    })
  })

  describe('TopicStatsDao', () => {
    it('get returns null for never-discussed topic', () => {
      expect(stats.get('minecraft')).toBeNull()
    })

    it('all() returns empty array before any session', () => {
      expect(stats.all()).toEqual([])
    })

    it('incrementAndUpdate on a fresh topic: INSERT count=1 with first/last = now', () => {
      const now = new Date('2026-06-09T10:00:00.000Z')
      stats.incrementAndUpdate('minecraft', now)
      const row = stats.get('minecraft')
      expect(row).toEqual({
        topic: 'minecraft',
        discussionCount: 1,
        firstDiscussedAt: '2026-06-09T10:00:00.000Z',
        lastDiscussedAt: '2026-06-09T10:00:00.000Z',
      })
    })

    it('incrementAndUpdate on existing topic: count++, last updates, first unchanged', () => {
      const t1 = new Date('2026-06-09T10:00:00.000Z')
      const t2 = new Date('2026-06-09T11:30:00.000Z')
      stats.incrementAndUpdate('minecraft', t1)
      stats.incrementAndUpdate('minecraft', t2)
      const row = stats.get('minecraft')
      expect(row?.discussionCount).toBe(2)
      expect(row?.firstDiscussedAt).toBe('2026-06-09T10:00:00.000Z') // unchanged
      expect(row?.lastDiscussedAt).toBe('2026-06-09T11:30:00.000Z') // updated
    })

    it('all() orders by last_discussed_at DESC, then topic ASC', () => {
      // 3 topics, minecraft most recent, school oldest
      stats.incrementAndUpdate('minecraft', new Date('2026-06-09T10:00:00.000Z'))
      stats.incrementAndUpdate('school', new Date('2026-06-08T10:00:00.000Z'))
      stats.incrementAndUpdate('food', new Date('2026-06-09T11:00:00.000Z'))
      const all = stats.all()
      expect(all.map((s) => s.topic)).toEqual(['food', 'minecraft', 'school'])
    })
  })
})
