import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyMigrations, openDb } from '../../src/storage/db.js'
import { resolveMigrationsDirForTesting } from './helpers.js'

const migrationsDir = resolveMigrationsDirForTesting()

describe('storage/db', () => {
  let dir: string
  let db: ReturnType<typeof openDb>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'storage-test-'))
    db = openDb({ dataDir: dir })
    applyMigrations(db, migrationsDir)
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  // ---- L1 ----

  it('integrity_check returns "ok" after fresh init', () => {
    expect(db.integrityCheck()).toBe('ok')
  })

  it('creates sessions and messages tables after migration', () => {
    const tables = (
      db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
        name: string
      }[]
    ).map((r) => r.name)
    expect(tables).toContain('sessions')
    expect(tables).toContain('messages')
    expect(tables).toContain('schema_migrations')
  })

  it('re-running migrations is a no-op (idempotent)', () => {
    applyMigrations(db, migrationsDir)
    const tables = (
      db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
        name: string
      }[]
    ).filter((r) => r.name === 'sessions')
    expect(tables).toHaveLength(1)
  })

  // ---- L2 ----

  it('creates db file inside the data dir', () => {
    const dbPath = join(dir, 'oral-teacher.db')
    expect(existsSync(dbPath)).toBe(true)
  })

  it('rebuilds db cleanly if file is removed', () => {
    db.close()
    rmSync(join(dir, 'oral-teacher.db'))
    const db2 = openDb({ dataDir: dir })
    applyMigrations(db2, migrationsDir)
    expect(db2.integrityCheck()).toBe('ok')
    db2.close()
  })
})
