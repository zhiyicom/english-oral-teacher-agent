import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyMigrations, openDb } from '../../src/storage/db.js'
import { createMessagesDao } from '../../src/storage/messages.js'
import { createSessionsDao } from '../../src/storage/sessions.js'
import { resolveMigrationsDirForTesting } from './helpers.js'

const migrationsDir = resolveMigrationsDirForTesting()

describe('MessagesDao', () => {
  let dir: string
  let db: ReturnType<typeof openDb>
  let sessions: ReturnType<typeof createSessionsDao>
  let messages: ReturnType<typeof createMessagesDao>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'messages-test-'))
    db = openDb({ dataDir: dir })
    applyMigrations(db, migrationsDir)
    sessions = createSessionsDao(db)
    messages = createMessagesDao(db)
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('appends and reads back in ts ASC order', () => {
    sessions.create({ id: 's1' })
    messages.append({
      sessionId: 's1',
      role: 'user',
      content: 'first',
      ts: '2026-06-05T10:00:01.000Z',
    })
    messages.append({
      sessionId: 's1',
      role: 'assistant',
      content: 'reply',
      ts: '2026-06-05T10:00:02.000Z',
    })
    messages.append({
      sessionId: 's1',
      role: 'user',
      content: 'second',
      ts: '2026-06-05T10:00:03.000Z',
    })
    const rows = messages.getBySession('s1')
    expect(rows.map((r) => r.content)).toEqual(['first', 'reply', 'second'])
    expect(rows.map((r) => r.role)).toEqual(['user', 'assistant', 'user'])
  })

  it('isolates messages between different sessions', () => {
    sessions.create({ id: 's1' })
    sessions.create({ id: 's2' })
    messages.append({
      sessionId: 's1',
      role: 'user',
      content: 'for s1',
      ts: '2026-06-05T10:00:00.000Z',
    })
    messages.append({
      sessionId: 's2',
      role: 'user',
      content: 'for s2',
      ts: '2026-06-05T10:00:01.000Z',
    })
    expect(messages.getBySession('s1')).toHaveLength(1)
    expect(messages.getBySession('s2')).toHaveLength(1)
    expect(messages.getBySession('s1')[0]?.content).toBe('for s1')
    expect(messages.countBySession('s1')).toBe(1)
    expect(messages.countBySession('s2')).toBe(1)
  })
})
