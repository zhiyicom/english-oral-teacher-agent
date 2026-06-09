import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MarkMistakeArgsSchema,
  createMarkMistakeTool,
} from '../../../src/agent/tools/mark-mistake.js'
import { applyMigrations, openDb } from '../../../src/storage/db.js'
import { createMistakesDao } from '../../../src/storage/mistakes.js'
import { createSessionsDao } from '../../../src/storage/sessions.js'
import { resolveMigrationsDirForTesting } from '../../storage/helpers.js'

const migrationsDir = resolveMigrationsDirForTesting()

describe('mark_mistake tool (v0.7 L1)', () => {
  let dir: string
  let db: ReturnType<typeof openDb>
  let sessionId: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tool-mistake-test-'))
    db = openDb({ dataDir: dir })
    applyMigrations(db, migrationsDir)
    sessionId = createSessionsDao(db).create().id
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  describe('schema', () => {
    it('accepts a well-formed args object', () => {
      const ok = MarkMistakeArgsSchema.safeParse({
        original: 'I go',
        corrected: 'I went',
        category: 'grammar',
      })
      expect(ok.success).toBe(true)
    })

    it('rejects unknown category enum value', () => {
      const bad = MarkMistakeArgsSchema.safeParse({
        original: 'a',
        corrected: 'b',
        category: 'punctuation',
      })
      expect(bad.success).toBe(false)
    })

    it('rejects empty original / corrected strings', () => {
      expect(
        MarkMistakeArgsSchema.safeParse({ original: '', corrected: 'x', category: 'grammar' })
          .success,
      ).toBe(false)
      expect(
        MarkMistakeArgsSchema.safeParse({ original: 'x', corrected: '', category: 'grammar' })
          .success,
      ).toBe(false)
    })

    it('rejects original longer than 500 chars', () => {
      const tooLong = 'a'.repeat(501)
      expect(
        MarkMistakeArgsSchema.safeParse({
          original: tooLong,
          corrected: 'b',
          category: 'grammar',
        }).success,
      ).toBe(false)
    })
  })

  describe('execute', () => {
    it('writes a mistake row bound to the factory-injected sessionId', () => {
      const tool = createMarkMistakeTool(db, sessionId)
      tool.execute({
        original: 'I go to school yesterday',
        corrected: 'I went to school yesterday',
        category: 'grammar',
      })
      const rows = createMistakesDao(db).getBySession(sessionId)
      expect(rows).toHaveLength(1)
      expect(rows[0]?.original).toBe('I go to school yesterday')
      expect(rows[0]?.corrected).toBe('I went to school yesterday')
      expect(rows[0]?.category).toBe('grammar')
      expect(rows[0]?.sessionId).toBe(sessionId)
    })

    it('throws (zod) when args are invalid — caller wraps in try/catch', () => {
      const tool = createMarkMistakeTool(db, sessionId)
      expect(() => tool.execute({ category: 'grammar' })).toThrow()
    })

    it('does NOT accept a sessionId override from args (factory injection is authoritative)', () => {
      const tool = createMarkMistakeTool(db, sessionId)
      tool.execute({
        // sneaky extra field — schema strips it
        sessionId: 'attacker-session',
        original: 'a',
        corrected: 'b',
        category: 'spelling',
      } as unknown)
      const rows = createMistakesDao(db).getBySession(sessionId)
      expect(rows).toHaveLength(1)
      const stolen = createMistakesDao(db).getBySession('attacker-session')
      expect(stolen).toEqual([])
    })

    it('returns the inserted Mistake row from execute', () => {
      const tool = createMarkMistakeTool(db, sessionId)
      const result = tool.execute({
        original: 'gonna',
        corrected: 'going to',
        category: 'grammar',
      }) as { id: number; original: string }
      expect(result.id).toBeGreaterThan(0)
      expect(result.original).toBe('gonna')
    })
  })

  describe('Tool interface compliance', () => {
    it('exposes name="mark_mistake" and a non-empty description', () => {
      const tool = createMarkMistakeTool(db, sessionId)
      expect(tool.name).toBe('mark_mistake')
      expect(tool.description.length).toBeGreaterThan(10)
    })
  })
})
