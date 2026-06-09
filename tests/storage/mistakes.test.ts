import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyMigrations, openDb } from '../../src/storage/db.js'
import { type MistakesDao, createMistakesDao } from '../../src/storage/mistakes.js'
import { createSessionsDao } from '../../src/storage/sessions.js'
import { resolveMigrationsDirForTesting } from './helpers.js'

const migrationsDir = resolveMigrationsDirForTesting()

describe('MistakesDao (v0.7 migration 004)', () => {
  let dir: string
  let db: ReturnType<typeof openDb>
  let mistakes: MistakesDao
  let sessionId: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mistakes-test-'))
    db = openDb({ dataDir: dir })
    applyMigrations(db, migrationsDir)
    mistakes = createMistakesDao(db)
    // FK requires a parent session row to exist
    const sessions = createSessionsDao(db)
    sessionId = sessions.create().id
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  describe('append + getBySession', () => {
    it('append returns the inserted row with an autoincrement id', () => {
      const row = mistakes.append({
        sessionId,
        original: 'I go to school yesterday',
        corrected: 'I went to school yesterday',
        category: 'grammar',
        ts: '2026-06-09T10:00:00.000Z',
      })
      expect(row.id).toBeGreaterThan(0)
      expect(row.sessionId).toBe(sessionId)
      expect(row.original).toBe('I go to school yesterday')
      expect(row.corrected).toBe('I went to school yesterday')
      expect(row.category).toBe('grammar')
      expect(row.ts).toBe('2026-06-09T10:00:00.000Z')
    })

    it('getBySession returns rows in ts ASC order for the given session', () => {
      mistakes.append({
        sessionId,
        original: 'a',
        corrected: 'A',
        category: 'spelling',
        ts: '2026-06-09T11:00:00.000Z',
      })
      mistakes.append({
        sessionId,
        original: 'b',
        corrected: 'B',
        category: 'vocabulary',
        ts: '2026-06-09T10:00:00.000Z',
      })
      const rows = mistakes.getBySession(sessionId)
      expect(rows).toHaveLength(2)
      expect(rows[0]?.original).toBe('b') // earlier ts first
      expect(rows[1]?.original).toBe('a')
    })

    it('getBySession on unknown session returns empty array', () => {
      expect(mistakes.getBySession('nonexistent-session-id')).toEqual([])
    })

    it('append without explicit ts uses ISO now and is queryable', () => {
      const before = Date.now()
      const row = mistakes.append({
        sessionId,
        original: 'gonna',
        corrected: 'going to',
        category: 'grammar',
      })
      const after = Date.now()
      const tsMs = Date.parse(row.ts)
      expect(tsMs).toBeGreaterThanOrEqual(before)
      expect(tsMs).toBeLessThanOrEqual(after)
    })
  })

  describe('getRecent (cross-session)', () => {
    it('returns the N most recent rows DESC by ts, across sessions', () => {
      const sessions = createSessionsDao(db)
      const sid2 = sessions.create().id
      mistakes.append({
        sessionId,
        original: 'old',
        corrected: 'old!',
        category: 'grammar',
        ts: '2026-06-09T08:00:00.000Z',
      })
      mistakes.append({
        sessionId: sid2,
        original: 'mid',
        corrected: 'mid!',
        category: 'vocabulary',
        ts: '2026-06-09T09:00:00.000Z',
      })
      mistakes.append({
        sessionId,
        original: 'new',
        corrected: 'new!',
        category: 'spelling',
        ts: '2026-06-09T10:00:00.000Z',
      })
      const recent = mistakes.getRecent(2)
      expect(recent.map((m) => m.original)).toEqual(['new', 'mid'])
    })

    it('limit larger than rows returns all rows', () => {
      mistakes.append({
        sessionId,
        original: 'only',
        corrected: 'only!',
        category: 'grammar',
        ts: '2026-06-09T08:00:00.000Z',
      })
      expect(mistakes.getRecent(99)).toHaveLength(1)
    })
  })

  describe('constraints (L2: real DB enforcement)', () => {
    it('CHECK constraint rejects category outside the enum', () => {
      expect(() =>
        mistakes.append({
          sessionId,
          original: 'x',
          corrected: 'y',
          // @ts-expect-error testing runtime CHECK
          category: 'bogus',
        }),
      ).toThrow(/CHECK constraint failed|constraint failed/i)
    })

    it('FK constraint rejects appending for a non-existent session', () => {
      expect(() =>
        mistakes.append({
          sessionId: 'no-such-session',
          original: 'x',
          corrected: 'y',
          category: 'grammar',
        }),
      ).toThrow(/FOREIGN KEY constraint failed/i)
    })

    it('ON DELETE CASCADE removes mistakes when the parent session is deleted', () => {
      mistakes.append({
        sessionId,
        original: 'x',
        corrected: 'y',
        category: 'grammar',
        ts: '2026-06-09T08:00:00.000Z',
      })
      expect(mistakes.getBySession(sessionId)).toHaveLength(1)
      db.raw.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId)
      expect(mistakes.getBySession(sessionId)).toHaveLength(0)
    })
  })
})
