import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyMigrations, openDb } from '../../src/storage/db.js'
import {
  type KeywordHitsDao,
  createKeywordHitsDao,
} from '../../src/storage/topics.js'
import { resolveMigrationsDirForTesting } from './helpers.js'

const migrationsDir = resolveMigrationsDirForTesting()

describe('KeywordHitsDao (v1.0.2 migration 006)', () => {
  let dir: string
  let db: ReturnType<typeof openDb>
  let hits: KeywordHitsDao

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'keyword-hits-test-'))
    db = openDb({ dataDir: dir })
    applyMigrations(db, migrationsDir)
    hits = createKeywordHitsDao(db)
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  describe('table + indexes', () => {
    it('migration 006 creates the keyword_hits table', () => {
      // If the table wasn't created, getAll() would throw. Empty is the
      // expected initial state.
      expect(hits.getAll()).toEqual([])
    })
  })

  describe('upsertMany', () => {
    it('inserts new keywords with hit_count=1 and first/last = now', () => {
      const now = new Date('2026-06-28T10:00:00.000Z')
      hits.upsertMany('travel', ['trip', 'vacation'], now)
      const all = hits.getByTopic('travel')
      expect(all).toHaveLength(2)
      // alphabetical order: trip, vacation
      expect(all[0]).toEqual({
        topic: 'travel',
        keyword: 'trip',
        hitCount: 1,
        firstHitAt: '2026-06-28T10:00:00.000Z',
        lastHitAt: '2026-06-28T10:00:00.000Z',
      })
      expect(all[1]?.keyword).toBe('vacation')
    })

    it('accumulates hit_count on repeated calls for the same keyword', () => {
      const t1 = new Date('2026-06-28T10:00:00.000Z')
      const t2 = new Date('2026-06-28T11:00:00.000Z')
      const t3 = new Date('2026-06-28T12:00:00.000Z')
      hits.upsertMany('travel', ['trip'], t1)
      hits.upsertMany('travel', ['trip'], t2)
      hits.upsertMany('travel', ['trip'], t3)
      const row = hits.getByTopic('travel')[0]
      expect(row?.hitCount).toBe(3)
      // first preserved
      expect(row?.firstHitAt).toBe('2026-06-28T10:00:00.000Z')
      // last tracks the most recent call
      expect(row?.lastHitAt).toBe('2026-06-28T12:00:00.000Z')
    })

    it('does NOT touch unrelated (topic, keyword) pairs on upsert', () => {
      const now = new Date('2026-06-28T10:00:00.000Z')
      hits.upsertMany('travel', ['trip'], now)
      hits.upsertMany('food', ['pizza'], now)
      hits.upsertMany('travel', ['vacation'], now)
      // Only 'travel' x ['trip', 'vacation'] get touched.
      expect(hits.getByTopic('travel')).toHaveLength(2)
      expect(hits.getByTopic('food')).toHaveLength(1)
      expect(hits.getByTopic('minecraft')).toEqual([])
    })

    it('empty keyword list is a no-op (no rows inserted)', () => {
      const now = new Date('2026-06-28T10:00:00.000Z')
      hits.upsertMany('travel', [], now)
      expect(hits.getAll()).toEqual([])
    })

    it('keywords are stored verbatim — DAO trusts caller normalization', () => {
      // matchTopic() in topic-matcher.ts normalizes to lowercase before
      // passing into shared[]. We mirror that contract here: the DAO
      // does not double-normalize. Caller is responsible.
      const now = new Date('2026-06-28T10:00:00.000Z')
      hits.upsertMany('Travel', ['Trip'], now)
      const row = hits.getByTopic('Travel')[0]
      expect(row?.topic).toBe('Travel')
      expect(row?.keyword).toBe('Trip')
    })
  })

  describe('queries', () => {
    it('getByTopic returns alphabetical rows for a single topic', () => {
      const now = new Date('2026-06-28T10:00:00.000Z')
      hits.upsertMany('travel', ['holiday', 'beach', 'trip'], now)
      const all = hits.getByTopic('travel')
      expect(all.map((h) => h.keyword)).toEqual(['beach', 'holiday', 'trip'])
    })

    it('getByTopic returns [] for a topic with no hits', () => {
      expect(hits.getByTopic('nope')).toEqual([])
    })

    it('getAll returns rows ordered by topic ASC, keyword ASC', () => {
      const now = new Date('2026-06-28T10:00:00.000Z')
      hits.upsertMany('travel', ['trip'], now)
      hits.upsertMany('food', ['pizza', 'burger'], now)
      hits.upsertMany('travel', ['vacation'], now)
      const all = hits.getAll().map((h) => `${h.topic}:${h.keyword}`)
      expect(all).toEqual([
        'food:burger',
        'food:pizza',
        'travel:trip',
        'travel:vacation',
      ])
    })
  })
})