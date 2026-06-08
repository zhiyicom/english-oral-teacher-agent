import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadLastReview } from '../../src/agent/retrieval.js'
import { applyMigrations, openDb } from '../../src/storage/db.js'
import { createSessionsDao } from '../../src/storage/sessions.js'
import { resolveMigrationsDirForTesting } from '../storage/helpers.js'

const migrationsDir = resolveMigrationsDirForTesting()

describe('loadLastReview', () => {
  let dir: string
  let db: ReturnType<typeof openDb>
  let sessions: ReturnType<typeof createSessionsDao>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'retrieval-test-'))
    db = openDb({ dataDir: dir })
    applyMigrations(db, migrationsDir)
    sessions = createSessionsDao(db)
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('empty sessions table → returns null', () => {
    expect(loadLastReview(db)).toBeNull()
  })

  it('1 session with summary → returns full LastReview', () => {
    sessions.create({ id: 's1', startedAt: '2026-06-05T10:00:00.000Z' })
    sessions.markEnded('s1', {
      endedAt: '2026-06-05T10:05:00.000Z',
      summary: 'Student talked about castles.',
      keywords: ['castle', 'minecraft'],
    })
    const now = new Date('2026-06-06T10:00:00.000Z')
    const r = loadLastReview(db, now)
    expect(r).not.toBeNull()
    expect(r?.sessionId).toBe('s1')
    expect(r?.summary).toBe('Student talked about castles.')
    expect(r?.keywords).toEqual(['castle', 'minecraft'])
    expect(r?.durationMin).toBe(5)
    expect(r?.startedAt).toBe('2026-06-05T10:00:00.000Z')
  })

  it('2 sessions → returns the one with later started_at', () => {
    sessions.create({ id: 'older', startedAt: '2026-06-04T10:00:00.000Z' })
    sessions.markEnded('older', { summary: 'old summary', keywords: ['a', 'b', 'c'] })
    sessions.create({ id: 'newer', startedAt: '2026-06-05T10:00:00.000Z' })
    sessions.markEnded('newer', { summary: 'new summary', keywords: ['d', 'e', 'f'] })

    const r = loadLastReview(db)
    expect(r?.sessionId).toBe('newer')
    expect(r?.summary).toBe('new summary')
  })

  it('session with NULL summary is skipped (v0.3 / pre-v0.5 rows)', () => {
    sessions.create({ id: 'old', startedAt: '2026-06-04T10:00:00.000Z' })
    sessions.markEnded('old', { endedAt: '2026-06-04T10:05:00.000Z' }) // no summary
    sessions.create({ id: 'new', startedAt: '2026-06-05T10:00:00.000Z' })
    sessions.markEnded('new', { summary: 'fresh', keywords: ['x', 'y', 'z'] })

    const r = loadLastReview(db)
    expect(r?.sessionId).toBe('new')
    expect(r?.summary).toBe('fresh')
  })

  it('all sessions have NULL summary → returns null', () => {
    sessions.create({ id: 'a', startedAt: '2026-06-04T10:00:00.000Z' })
    sessions.markEnded('a', { endedAt: '2026-06-04T10:05:00.000Z' })
    sessions.create({ id: 'b', startedAt: '2026-06-05T10:00:00.000Z' })
    sessions.markEnded('b', { endedAt: '2026-06-05T10:05:00.000Z' })
    expect(loadLastReview(db)).toBeNull()
  })

  it('keywords field is parsed from JSON array', () => {
    sessions.create({ id: 'k', startedAt: '2026-06-05T10:00:00.000Z' })
    sessions.markEnded('k', { summary: 's', keywords: ['one', 'two', 'three'] })
    const r = loadLastReview(db)
    expect(r?.keywords).toEqual(['one', 'two', 'three'])
  })

  // daysAgo boundary tests — Math.floor((now - startedAt) / 86_400_000)
  it('daysAgo: startedAt = 23h ago → 0', () => {
    const now = new Date('2026-06-06T10:00:00.000Z')
    const startedAt = new Date(now.getTime() - 23 * 3600_000).toISOString()
    sessions.create({ id: 'd1', startedAt })
    sessions.markEnded('d1', { summary: 's', keywords: ['a', 'b', 'c'] })
    expect(loadLastReview(db, now)?.daysAgo).toBe(0)
  })

  it('daysAgo: startedAt = 25h ago → 1', () => {
    const now = new Date('2026-06-06T10:00:00.000Z')
    const startedAt = new Date(now.getTime() - 25 * 3600_000).toISOString()
    sessions.create({ id: 'd2', startedAt })
    sessions.markEnded('d2', { summary: 's', keywords: ['a', 'b', 'c'] })
    expect(loadLastReview(db, now)?.daysAgo).toBe(1)
  })

  it('daysAgo: startedAt = 47h ago → 1 (does not roll into 2)', () => {
    const now = new Date('2026-06-06T10:00:00.000Z')
    const startedAt = new Date(now.getTime() - 47 * 3600_000).toISOString()
    sessions.create({ id: 'd3', startedAt })
    sessions.markEnded('d3', { summary: 's', keywords: ['a', 'b', 'c'] })
    expect(loadLastReview(db, now)?.daysAgo).toBe(1)
  })

  it('daysAgo: startedAt = 49h ago → 2', () => {
    const now = new Date('2026-06-06T10:00:00.000Z')
    const startedAt = new Date(now.getTime() - 49 * 3600_000).toISOString()
    sessions.create({ id: 'd4', startedAt })
    sessions.markEnded('d4', { summary: 's', keywords: ['a', 'b', 'c'] })
    expect(loadLastReview(db, now)?.daysAgo).toBe(2)
  })

  it('daysAgo: startedAt == now → 0 (no negative)', () => {
    const now = new Date('2026-06-06T10:00:00.000Z')
    sessions.create({ id: 'd5', startedAt: now.toISOString() })
    sessions.markEnded('d5', { summary: 's', keywords: ['a', 'b', 'c'] })
    expect(loadLastReview(db, now)?.daysAgo).toBe(0)
  })
})
