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
  /**
   * v1.1.0 §1.2 — INSERT OR IGNORE a new topic. Returns true when the
   * row was actually inserted, false when the name already exists (the
   * OR IGNORE clause silently skipped the duplicate). Used by
   * `autoExpandTopicLibrary` to add LLM-curated topics at runtime.
   */
  create(input: {
    name: string
    keywords: string[]
    description: string | null
    createdAt: string
  }): boolean
}

export interface TopicStatsDao {
  get(topic: string): TopicStat | null
  all(): TopicStat[]
  incrementAndUpdate(topic: string, now: Date): void
}

export interface KeywordHit {
  topic: string
  keyword: string
  hitCount: number
  firstHitAt: string | null
  lastHitAt: string | null
}

export interface KeywordHitsDao {
  upsertMany(topic: string, keywords: string[], now: Date): void
  getAll(): KeywordHit[]
  getByTopic(topic: string): KeywordHit[]
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

interface KeywordHitRow {
  topic: string
  keyword: string
  hit_count: number
  first_hit_at: string | null
  last_hit_at: string | null
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

function rowToKeywordHit(row: KeywordHitRow): KeywordHit {
  return {
    topic: row.topic,
    keyword: row.keyword,
    hitCount: row.hit_count,
    firstHitAt: row.first_hit_at,
    lastHitAt: row.last_hit_at,
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
  // v1.1.0 §1.2 — INSERT OR IGNORE keeps the auto-expand path idempotent:
  // if the LLM proposes a slug that already exists (e.g. raced with another
  // session or the baseline), the call returns changes=0 and we treat it
  // as "skip, not error". Same pattern as migration 007's seed.
  const insertOne = raw.prepare(
    'INSERT OR IGNORE INTO topics (name, keywords_json, description, created_at) VALUES (?, ?, ?, ?)',
  )
  return {
    list() {
      return (selectAll.all() as TopicRow[]).map(rowToTopic)
    },
    get(name) {
      const row = selectOne.get(name) as TopicRow | undefined
      return row ? rowToTopic(row) : null
    },
    create(input) {
      const r = insertOne.run(
        input.name,
        JSON.stringify(input.keywords),
        input.description,
        input.createdAt,
      )
      return r.changes > 0
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

export function createKeywordHitsDao(handle: DbHandle): KeywordHitsDao {
  const { raw } = handle
  const selectAll = raw.prepare(`
    SELECT topic, keyword, hit_count, first_hit_at, last_hit_at
    FROM keyword_hits
    ORDER BY topic ASC, keyword ASC
  `)
  const selectByTopic = raw.prepare(`
    SELECT topic, keyword, hit_count, first_hit_at, last_hit_at
    FROM keyword_hits
    WHERE topic = ?
    ORDER BY keyword ASC
  `)
  // UPSERT each (topic, keyword) pair.
  // - INSERT: count starts at 1, first/last = now.
  // - UPDATE: count += 1, last_hit_at = now; first_hit_at preserved.
  // The INSERT ... ON CONFLICT ... DO UPDATE is atomic per statement
  // (better-sqlite3 runs each .run() in implicit transaction).
  const upsertOne = raw.prepare(`
    INSERT INTO keyword_hits (topic, keyword, hit_count, first_hit_at, last_hit_at)
    VALUES (?, ?, 1, ?, ?)
    ON CONFLICT(topic, keyword) DO UPDATE SET
      hit_count = hit_count + 1,
      last_hit_at = excluded.last_hit_at
  `)
  return {
    upsertMany(topic, keywords, now) {
      if (keywords.length === 0) return
      const nowIso = now.toISOString()
      // Wrap in a single transaction so N UPSERTs are atomic.
      const tx = raw.transaction((items: string[]) => {
        for (const k of items) upsertOne.run(topic, k, nowIso, nowIso)
      })
      tx(keywords)
    },
    getAll() {
      return (selectAll.all() as KeywordHitRow[]).map(rowToKeywordHit)
    },
    getByTopic(topic) {
      return (selectByTopic.all(topic) as KeywordHitRow[]).map(rowToKeywordHit)
    },
  }
}
