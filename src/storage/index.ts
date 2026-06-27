export { applyMigrations, openDb, type DbHandle, type DbOptions } from './db.js'
export {
  createSessionsDao,
  type CreateSessionInput,
  type MarkEndedInput,
  type Session,
  type SessionsDao,
  type SessionWithEmbedding,
} from './sessions.js'
export {
  createMessagesDao,
  type AppendMessageInput,
  type MessageRole,
  type MessageRow,
  type MessagesDao,
} from './messages.js'
export {
  type Topic,
  type TopicStat,
  type TopicStatsDao,
  type TopicsDao,
  type KeywordHit,
  type KeywordHitsDao,
  createTopicStatsDao,
  createTopicsDao,
  createKeywordHitsDao,
} from './topics.js'
export {
  type AppendMistakeInput,
  type Mistake,
  type MistakeCategory,
  type MistakesDao,
  createMistakesDao,
} from './mistakes.js'
