import type { DbHandle } from './db.js'

export interface Topic {
  name: string
  keywords: string[]
  description: string | null
  createdAt: string
}

export interface TopicStat {
  topic: string
  discussionCount: number
  firstDiscussedAt: string | null
  lastDiscussedAt: string | null
}

export interface TopicsDao {
  list(): Topic[]
  get(name: string): Topic | null
}

export interface TopicStatsDao {
  get(topic: string): TopicStat | null
  all(): TopicStat[]
  incrementAndUpdate(topic: string, now: Date): void
}

interface TopicRow {
  name: string
  keywords_json: string
  description: string | null
  created_at: string
}

interface TopicStatRow {
  topic: string
  discussion_count: number
  first_discussed_at: string | null
  last_discussed_at: string | null
}

function rowToTopic(row: TopicRow): Topic {
  return {
    name: row.name,
    keywords: JSON.parse(row.keywords_json) as string[],
    description: row.description,
    createdAt: row.created_at,
  }
}

function rowToStat(row: TopicStatRow): TopicStat {
  return {
    topic: row.topic,
    discussionCount: row.discussion_count,
    firstDiscussedAt: row.first_discussed_at,
    lastDiscussedAt: row.last_discussed_at,
  }
}

export function createTopicsDao(handle: DbHandle): TopicsDao {
  const { raw } = handle
  const selectAll = raw.prepare(
    'SELECT name, keywords_json, description, created_at FROM topics ORDER BY name',
  )
  const selectOne = raw.prepare(
    'SELECT name, keywords_json, description, created_at FROM topics WHERE name = ?',
  )
  return {
    list() {
      return (selectAll.all() as TopicRow[]).map(rowToTopic)
    },
    get(name) {
      const row = selectOne.get(name) as TopicRow | undefined
      return row ? rowToTopic(row) : null
    },
  }
}

export function createTopicStatsDao(handle: DbHandle): TopicStatsDao {
  const { raw } = handle
  const selectAll = raw.prepare(`
    SELECT topic, discussion_count, first_discussed_at, last_discussed_at
    FROM topic_stats
    ORDER BY last_discussed_at DESC, topic ASC
  `)
  const selectOne = raw.prepare(`
    SELECT topic, discussion_count, first_discussed_at, last_discussed_at
    FROM topic_stats WHERE topic = ?
  `)
  const upsert = raw.prepare(`
    INSERT INTO topic_stats (topic, discussion_count, first_discussed_at, last_discussed_at)
    VALUES (?, 1, ?, ?)
    ON CONFLICT(topic) DO UPDATE SET
      discussion_count = discussion_count + 1,
      last_discussed_at = excluded.last_discussed_at
  `)
  return {
    get(topic) {
      const row = selectOne.get(topic) as TopicStatRow | undefined
      return row ? rowToStat(row) : null
    },
    all() {
      return (selectAll.all() as TopicStatRow[]).map(rowToStat)
    },
    incrementAndUpdate(topic, now) {
      const nowIso = now.toISOString()
      upsert.run(topic, nowIso, nowIso)
    },
  }
}
