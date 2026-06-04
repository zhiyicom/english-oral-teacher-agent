import type { DbHandle } from './db.js'

export type MessageRole = 'user' | 'assistant' | 'system'

export interface MessageRow {
  id: number
  session_id: string
  role: MessageRole
  content: string
  ts: string
  voice_used: 0 | 1
}

export interface AppendMessageInput {
  sessionId: string
  role: MessageRole
  content: string
  ts?: string
  voiceUsed?: 0 | 1
}

export interface MessagesDao {
  append(input: AppendMessageInput): MessageRow
  getBySession(sessionId: string): MessageRow[]
  countBySession(sessionId: string): number
}

export function createMessagesDao(handle: DbHandle): MessagesDao {
  const { raw } = handle

  const insert = raw.prepare(`
    INSERT INTO messages (session_id, role, content, ts, voice_used)
    VALUES (?, ?, ?, ?, ?)
  `)
  const select = raw.prepare(`
    SELECT id, session_id, role, content, ts, voice_used
    FROM messages
    WHERE session_id = ?
    ORDER BY ts ASC, id ASC
  `)
  const count = raw.prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?')

  return {
    append(input: AppendMessageInput) {
      const ts = input.ts ?? new Date().toISOString()
      const voiceUsed = input.voiceUsed ?? 0
      const info = insert.run(input.sessionId, input.role, input.content, ts, voiceUsed)
      return {
        id: info.lastInsertRowid as number,
        session_id: input.sessionId,
        role: input.role,
        content: input.content,
        ts,
        voice_used: voiceUsed,
      }
    },
    getBySession(sessionId: string) {
      return select.all(sessionId) as MessageRow[]
    },
    countBySession(sessionId: string) {
      return (count.get(sessionId) as { n: number }).n
    },
  }
}
