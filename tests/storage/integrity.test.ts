import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyMigrations, openDb } from '../../src/storage/db.js'
import { createMessagesDao } from '../../src/storage/messages.js'
import { createSessionsDao } from '../../src/storage/sessions.js'
import { resolveMigrationsDirForTesting } from './helpers.js'

const migrationsDir = resolveMigrationsDirForTesting()

function safeRm(dir: string): void {
  // On Windows, better-sqlite3 in WAL mode can leave a brief file lock after close.
  // Retry with a small delay so cleanup doesn't fail spuriously.
  for (let i = 0; i < 3; i++) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      return
    } catch (err) {
      if (i === 2) {
        // Last attempt: warn but don't fail the test
        console.warn(`[integrity.test] cleanup warning: ${(err as Error).message}`)
        return
      }
    }
  }
}

describe('DB integrity across reopens', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'integrity-test-'))
  })
  afterEach(() => {
    safeRm(dir)
  })

  it('persists data after closing and reopening', () => {
    const db1 = openDb({ dataDir: dir })
    applyMigrations(db1, migrationsDir)
    const sessions1 = createSessionsDao(db1)
    const messages1 = createMessagesDao(db1)

    sessions1.create({ id: 'persist-1', startedAt: '2026-06-05T10:00:00.000Z' })
    messages1.append({
      sessionId: 'persist-1',
      role: 'user',
      content: 'hello',
      ts: '2026-06-05T10:00:01.000Z',
    })
    db1.close()

    // Reopen — represents "process restart"
    const db2 = openDb({ dataDir: dir })
    applyMigrations(db2, migrationsDir)
    const sessions2 = createSessionsDao(db2)
    const messages2 = createMessagesDao(db2)

    const session = sessions2.get('persist-1')
    expect(session).not.toBeNull()
    expect(session?.id).toBe('persist-1')

    const rows = messages2.getBySession('persist-1')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.content).toBe('hello')
    db2.close()
  })

  it('reports corruption when file content is not a valid SQLite header', () => {
    const db1 = openDb({ dataDir: dir })
    applyMigrations(db1, migrationsDir)
    const sessions1 = createSessionsDao(db1)
    sessions1.create({ id: 'corrupt-test' })
    db1.close()

    // Overwrite the SQLite file with garbage that is not a valid header.
    // This guarantees better-sqlite3 will reject the file on open.
    const dbPath = join(dir, 'oral-teacher.db')
    writeFileSync(dbPath, 'XXXX not a sqlite database XXXX')

    // Reopening should error (not silently create an empty DB)
    expect(() => openDb({ dataDir: dir })).toThrow()
  })
})
