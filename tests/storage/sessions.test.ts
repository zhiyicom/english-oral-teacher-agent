import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyMigrations, openDb } from '../../src/storage/db.js'
import { createSessionsDao } from '../../src/storage/sessions.js'
import { resolveMigrationsDirForTesting } from './helpers.js'

const migrationsDir = resolveMigrationsDirForTesting()

describe('SessionsDao', () => {
  let dir: string
  let db: ReturnType<typeof openDb>
  let sessions: ReturnType<typeof createSessionsDao>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sessions-test-'))
    db = openDb({ dataDir: dir })
    applyMigrations(db, migrationsDir)
    sessions = createSessionsDao(db)
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('create → get returns same row', () => {
    const s = sessions.create({ id: 'sess-1', startedAt: '2026-06-05T10:00:00.000Z' })
    const fetched = sessions.get('sess-1')
    expect(fetched).toEqual(s)
    expect(fetched?.id).toBe('sess-1')
    expect(fetched?.started_at).toBe('2026-06-05T10:00:00.000Z')
    expect(fetched?.ended_at).toBeNull()
    expect(fetched?.duration_min).toBeNull()
  })

  it('list orders by started_at DESC', () => {
    sessions.create({ id: 'a', startedAt: '2026-06-05T10:00:00.000Z' })
    sessions.create({ id: 'b', startedAt: '2026-06-05T11:00:00.000Z' })
    sessions.create({ id: 'c', startedAt: '2026-06-05T09:00:00.000Z' })
    expect(sessions.list().map((s) => s.id)).toEqual(['b', 'a', 'c'])
  })

  it('markEnded sets ended_at and computes duration', () => {
    sessions.create({ id: 'x', startedAt: '2026-06-05T10:00:00.000Z' })
    const ended = sessions.markEnded('x', { endedAt: '2026-06-05T10:25:00.000Z' })
    expect(ended.ended_at).toBe('2026-06-05T10:25:00.000Z')
    expect(ended.duration_min).toBe(25)

    const fetched = sessions.get('x')
    expect(fetched?.ended_at).toBe('2026-06-05T10:25:00.000Z')
    expect(fetched?.duration_min).toBe(25)
  })

  // v0.4 — phase_history persistence
  it('markEnded with phaseHistory writes JSON to phase_history column; re-parse returns same array', () => {
    sessions.create({ id: 'v4-1', startedAt: '2026-06-05T10:00:00.000Z' })
    const history = [
      { phase: 'WARM_UP' as const, at: 0, reason: 'time' as const },
      { phase: 'MAIN_ACTIVITY' as const, at: 5, reason: 'time' as const },
      { phase: 'WRAP_UP' as const, at: 25, reason: 'time' as const },
      { phase: 'END' as const, at: 30, reason: 'time' as const },
    ]
    sessions.markEnded('v4-1', {
      endedAt: '2026-06-05T10:30:00.000Z',
      phaseHistory: history,
    })

    const fetched = sessions.get('v4-1')
    expect(fetched?.phase_history).not.toBeNull()
    const parsed = JSON.parse(fetched?.phase_history ?? 'null')
    expect(parsed).toEqual(history)
  })

  it('markEnded without phaseHistory still works (backward compat with v0.3 callers)', () => {
    sessions.create({ id: 'v4-2', startedAt: '2026-06-05T10:00:00.000Z' })
    const ended = sessions.markEnded('v4-2', { endedAt: '2026-06-05T10:05:00.000Z' })
    expect(ended.ended_at).toBe('2026-06-05T10:05:00.000Z')
    expect(ended.duration_min).toBe(5)
    // phase_history is left null when not provided (or whatever was there before)
    expect(ended.phase_history).toBeNull()
  })

  // v0.5 — summary + keywords persistence
  it('markEnded with summary writes it to summary column; get reads it back', () => {
    sessions.create({ id: 'v5-1', startedAt: '2026-06-05T10:00:00.000Z' })
    sessions.markEnded('v5-1', {
      endedAt: '2026-06-05T10:05:00.000Z',
      summary: 'Student talked about Minecraft castles.',
    })
    const fetched = sessions.get('v5-1')
    expect(fetched?.summary).toBe('Student talked about Minecraft castles.')
  })

  it('markEnded with keywords writes JSON array to keywords column; get reads back as JSON', () => {
    sessions.create({ id: 'v5-2', startedAt: '2026-06-05T10:00:00.000Z' })
    sessions.markEnded('v5-2', {
      endedAt: '2026-06-05T10:05:00.000Z',
      keywords: ['minecraft', 'castle', 'creeper'],
    })
    const fetched = sessions.get('v5-2')
    expect(fetched?.keywords).not.toBeNull()
    const parsed = JSON.parse(fetched?.keywords ?? 'null')
    expect(parsed).toEqual(['minecraft', 'castle', 'creeper'])
  })

  it('markEnded with both summary and keywords writes both columns; get returns both', () => {
    sessions.create({ id: 'v5-3', startedAt: '2026-06-05T10:00:00.000Z' })
    sessions.markEnded('v5-3', {
      endedAt: '2026-06-05T10:05:00.000Z',
      summary: 'Student practiced talking about castles and creepers.',
      keywords: ['minecraft', 'castle', 'creeper', 'wall', 'build'],
    })
    const fetched = sessions.get('v5-3')
    expect(fetched?.summary).toBe('Student practiced talking about castles and creepers.')
    expect(JSON.parse(fetched?.keywords ?? '[]')).toEqual([
      'minecraft',
      'castle',
      'creeper',
      'wall',
      'build',
    ])
  })

  it('markEnded without summary/keywords leaves both columns null (backward compat with v0.4 callers)', () => {
    sessions.create({ id: 'v5-4', startedAt: '2026-06-05T10:00:00.000Z' })
    const ended = sessions.markEnded('v5-4', { endedAt: '2026-06-05T10:05:00.000Z' })
    expect(ended.summary).toBeNull()
    expect(ended.keywords).toBeNull()
  })

  it('markEnded COALESCE — second call without summary does not overwrite first', () => {
    sessions.create({ id: 'v5-5', startedAt: '2026-06-05T10:00:00.000Z' })
    sessions.markEnded('v5-5', {
      endedAt: '2026-06-05T10:05:00.000Z',
      summary: 'first summary',
      keywords: ['a', 'b', 'c'],
    })
    // Second call (e.g. due to error retry path) without summary/keywords
    sessions.markEnded('v5-5', { endedAt: '2026-06-05T10:06:00.000Z' })
    const fetched = sessions.get('v5-5')
    expect(fetched?.summary).toBe('first summary')
    expect(JSON.parse(fetched?.keywords ?? '[]')).toEqual(['a', 'b', 'c'])
    // ended_at should be updated to the new value
    expect(fetched?.ended_at).toBe('2026-06-05T10:06:00.000Z')
  })

  // v1.0.7 §11 — topics_used column write/read
  it('markEnded with topicsUsed writes JSON array; get reads it back as string[]', () => {
    sessions.create({ id: 'v107-1', startedAt: '2026-07-08T10:00:00.000Z' })
    sessions.markEnded('v107-1', {
      endedAt: '2026-07-08T10:30:00.000Z',
      topicsUsed: ['school_life', 'food_drink'],
    })
    const fetched = sessions.get('v107-1')
    expect(fetched?.topics_used).toEqual(['school_life', 'food_drink'])
  })

  it('markEnded without topicsUsed leaves topics_used at default [] (COALESCE preserves)', () => {
    sessions.create({ id: 'v107-2', startedAt: '2026-07-08T10:00:00.000Z' })
    sessions.markEnded('v107-2', { endedAt: '2026-07-08T10:05:00.000Z' })
    const fetched = sessions.get('v107-2')
    expect(fetched?.topics_used).toEqual([])
  })

  it('markEnded with empty topicsUsed array writes [] (not null)', () => {
    sessions.create({ id: 'v107-3', startedAt: '2026-07-08T10:00:00.000Z' })
    sessions.markEnded('v107-3', { endedAt: '2026-07-08T10:05:00.000Z', topicsUsed: [] })
    const fetched = sessions.get('v107-3')
    expect(fetched?.topics_used).toEqual([])
  })

  it('markEnded COALESCE — second call without topicsUsed does not wipe first', () => {
    sessions.create({ id: 'v107-4', startedAt: '2026-07-08T10:00:00.000Z' })
    sessions.markEnded('v107-4', {
      endedAt: '2026-07-08T10:30:00.000Z',
      topicsUsed: ['school_life'],
    })
    // Second call without topicsUsed (e.g. retry path)
    sessions.markEnded('v107-4', { endedAt: '2026-07-08T10:31:00.000Z' })
    const fetched = sessions.get('v107-4')
    expect(fetched?.topics_used).toEqual(['school_life'])
    expect(fetched?.ended_at).toBe('2026-07-08T10:31:00.000Z')
  })

  it('get returns topics_used as [] for legacy rows that were NULL before the patch ran', () => {
    sessions.create({ id: 'v107-5', startedAt: '2026-07-08T10:00:00.000Z' })
    // Simulate a row that bypassed the constructor (e.g. opened in another
    // process before the migration). Force topics_used back to NULL.
    db.raw.exec("UPDATE sessions SET topics_used = NULL WHERE id = 'v107-5'")
    const fetched = sessions.get('v107-5')
    expect(fetched?.topics_used).toEqual([])
  })

  it('startup patch is idempotent — running createSessionsDao twice does not error', () => {
    sessions.create({ id: 'v107-6', startedAt: '2026-07-08T10:00:00.000Z' })
    sessions.markEnded('v107-6', {
      endedAt: '2026-07-08T10:05:00.000Z',
      topicsUsed: ['school_life'],
    })
    // Second constructor invocation — should re-run the patch idempotently.
    const sessions2 = createSessionsDao(db)
    expect(sessions2.get('v107-6')?.topics_used).toEqual(['school_life'])
  })

  // v0.7.2 — embedding BLOB persistence for cross-session semantic retrieval
  it('setEmbedding + listWithEmbeddings roundtrip preserves Float32Array bit-for-bit', () => {
    sessions.create({ id: 'v72-1', startedAt: '2026-06-05T10:00:00.000Z' })
    sessions.markEnded('v72-1', {
      endedAt: '2026-06-05T10:05:00.000Z',
      summary: 'Student practiced Minecraft vocab.',
      keywords: ['minecraft', 'castle'],
    })
    const vec = new Float32Array([0.1, -0.2, 3.14, 1e-10, 0])
    sessions.setEmbedding('v72-1', vec)

    const rows = sessions.listWithEmbeddings()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe('v72-1')
    expect(rows[0]?.summary).toBe('Student practiced Minecraft vocab.')
    expect(rows[0]?.keywords).toEqual(['minecraft', 'castle'])
    expect(rows[0]?.embedding.length).toBe(vec.length)
    for (let i = 0; i < vec.length; i++) {
      expect(rows[0]?.embedding[i]).toBe(vec[i])
    }
  })

  it('listWithEmbeddings excludes rows where embedding is NULL', () => {
    // Row A: has summary AND embedding → should appear
    sessions.create({ id: 'v72-A', startedAt: '2026-06-05T10:00:00.000Z' })
    sessions.markEnded('v72-A', {
      endedAt: '2026-06-05T10:05:00.000Z',
      summary: 'A summary',
      keywords: ['a'],
    })
    sessions.setEmbedding('v72-A', new Float32Array([1, 2, 3]))

    // Row B: has summary but NO embedding → should NOT appear
    sessions.create({ id: 'v72-B', startedAt: '2026-06-05T11:00:00.000Z' })
    sessions.markEnded('v72-B', {
      endedAt: '2026-06-05T11:05:00.000Z',
      summary: 'B summary',
      keywords: ['b'],
    })

    // Row C: has embedding but NO summary (pathological — markEnded without summary)
    // → should NOT appear (WHERE summary IS NOT NULL)
    sessions.create({ id: 'v72-C', startedAt: '2026-06-05T12:00:00.000Z' })
    sessions.setEmbedding('v72-C', new Float32Array([4, 5, 6]))

    const rows = sessions.listWithEmbeddings()
    expect(rows.map((r) => r.id)).toEqual(['v72-A'])
  })
})

// v0.7.2 — migration 005 schema check (L2)
describe('Migration 005 — sessions.embedding column', () => {
  it('PRAGMA table_info(sessions) includes the embedding BLOB column', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sessions-migration-test-'))
    const db = openDb({ dataDir: dir })
    try {
      applyMigrations(db, migrationsDir)
      const cols = db.raw.prepare('PRAGMA table_info(sessions)').all() as Array<{
        name: string
        type: string
      }>
      const embedding = cols.find((c) => c.name === 'embedding')
      expect(embedding).toBeDefined()
      expect(embedding?.type.toUpperCase()).toBe('BLOB')
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
