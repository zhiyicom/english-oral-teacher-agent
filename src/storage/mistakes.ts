import type { DbHandle } from './db.js'

export type MistakeCategory = 'grammar' | 'vocabulary' | 'spelling'

export interface Mistake {
  id: number
  sessionId: string
  original: string
  corrected: string
  category: MistakeCategory
  ts: string
}

export interface AppendMistakeInput {
  sessionId: string
  original: string
  corrected: string
  category: MistakeCategory
  ts?: string
}

export interface MistakesDao {
  append(input: AppendMistakeInput): Mistake
  getBySession(sessionId: string): Mistake[]
  getRecent(limit: number): Mistake[]
}

interface MistakeRow {
  id: number
  session_id: string
  original: string
  corrected: string
  category: MistakeCategory
  ts: string
}

function rowToMistake(row: MistakeRow): Mistake {
  return {
    id: row.id,
    sessionId: row.session_id,
    original: row.original,
    corrected: row.corrected,
    category: row.category,
    ts: row.ts,
  }
}

const SELECT_COLS = 'id, session_id, original, corrected, category, ts'

export function createMistakesDao(handle: DbHandle): MistakesDao {
  const { raw } = handle
  const insert = raw.prepare(
    'INSERT INTO mistakes (session_id, original, corrected, category, ts) VALUES (?, ?, ?, ?, ?)',
  )
  const selectOne = raw.prepare(`SELECT ${SELECT_COLS} FROM mistakes WHERE id = ?`)
  const selectBySession = raw.prepare(
    `SELECT ${SELECT_COLS} FROM mistakes WHERE session_id = ? ORDER BY ts ASC, id ASC`,
  )
  const selectRecent = raw.prepare(
    `SELECT ${SELECT_COLS} FROM mistakes ORDER BY ts DESC, id DESC LIMIT ?`,
  )

  return {
    append(input) {
      const ts = input.ts ?? new Date().toISOString()
      const info = insert.run(input.sessionId, input.original, input.corrected, input.category, ts)
      const id = Number(info.lastInsertRowid)
      const row = selectOne.get(id) as MistakeRow
      return rowToMistake(row)
    },
    getBySession(sessionId) {
      return (selectBySession.all(sessionId) as MistakeRow[]).map(rowToMistake)
    },
    getRecent(limit) {
      return (selectRecent.all(limit) as MistakeRow[]).map(rowToMistake)
    },
  }
}
