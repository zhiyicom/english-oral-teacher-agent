import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { autoExpandTopicLibrary } from '../../src/agent/auto-expand.js'
import { applyMigrations, openDb } from '../../src/storage/db.js'
import {
  createKeywordHitsDao,
  createTopicStatsDao,
  createTopicsDao,
} from '../../src/storage/topics.js'
import type { Topic } from '../../src/storage/topics.js'
import type { ChatResult, LLMClient } from '../../src/llm/types.js'
import { resolveMigrationsDirForTesting } from '../storage/helpers.js'

const migrationsDir = resolveMigrationsDirForTesting()

// Fixture: small library that gives us predictable merge / create paths.
const TOPICS: Topic[] = [
  {
    name: 'aviation',
    keywords: ['aviation', 'aircraft', 'boeing', 'cockpit', '737'],
    description: 'Aviation',
    createdAt: '2026-07-01T00:00:00.000Z',
  },
  {
    name: 'food_drink',
    keywords: ['food', 'restaurant', 'cooking', 'pasta', 'italian'],
    description: 'Food and drink',
    createdAt: '2026-07-01T00:00:00.000Z',
  },
  {
    name: 'gaming',
    keywords: ['game', 'shooter', 'fps', 'minecraft', 'delta_force'],
    description: 'Gaming',
    createdAt: '2026-07-01T00:00:00.000Z',
  },
]

function stubClient(responses: ChatResult[]): LLMClient {
  let i = 0
  return {
    async *chatStream() {
      /* unused */
    },
    async chat(): Promise<ChatResult> {
      const r = responses[i++] ?? responses[responses.length - 1]
      if (!r) throw new Error('stubClient: no responses left')
      return r
    },
  }
}

function throwingClient(): LLMClient {
  return {
    async *chatStream() {
      /* unused */
    },
    async chat(): Promise<ChatResult> {
      throw new Error('network down')
    },
  }
}

describe('autoExpandTopicLibrary (v1.1.0 §1.3)', () => {
  let dir: string
  let db: ReturnType<typeof openDb>
  let topicStats: ReturnType<typeof createTopicStatsDao>
  let keywordHits: ReturnType<typeof createKeywordHitsDao>
  let topicsDao: ReturnType<typeof createTopicsDao>
  const now = new Date('2026-07-13T10:00:00.000Z')

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'auto-expand-test-'))
    db = openDb({ dataDir: dir })
    applyMigrations(db, migrationsDir)
    topicStats = createTopicStatsDao(db)
    keywordHits = createKeywordHitsDao(db)
    topicsDao = createTopicsDao(db)
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('A1: prefs.enabled=false short-circuits, LLM never called, no DB writes', async () => {
    const client = stubClient([]) // would throw if called
    await autoExpandTopicLibrary(
      ['boeing', '737'],
      [],
      { topics: TOPICS, topicStats, keywordHits, topicsDao, client },
      { now },
      { enabled: false },
    )
    expect(topicStats.all()).toEqual([])
    expect(keywordHits.getAll()).toEqual([])
  })

  it('A2: empty summaryKeywords short-circuits', async () => {
    const client = stubClient([])
    await autoExpandTopicLibrary(
      [],
      [],
      { topics: TOPICS, topicStats, keywordHits, topicsDao, client },
      { now },
      { enabled: true },
    )
    expect(topicStats.all()).toEqual([])
  })

  it('A3: LLM returns should_create=true with valid slug → 3 DAOs in order', async () => {
    const client = stubClient([
      {
        content: JSON.stringify({
          should_create: true,
          name: 'ceramics',
          keywords: ['pottery', 'ceramics', 'kiln', 'glaze'],
          description: 'Ceramics & pottery (A2-B1)',
        }),
      },
    ])
    await autoExpandTopicLibrary(
      ['pottery', 'ceramics', 'kiln', 'glaze'],
      [],
      { topics: TOPICS, topicStats, keywordHits, topicsDao, client },
      { now },
      { enabled: true },
    )
    // topics table gets the new row
    const newTopic = topicsDao.get('ceramics')
    expect(newTopic).not.toBeNull()
    expect(newTopic?.keywords).toEqual(['pottery', 'ceramics', 'kiln', 'glaze'])
    // topic_stats gets count=1
    const stat = topicStats.get('ceramics')
    expect(stat?.discussionCount).toBe(1)
    expect(stat?.firstDiscussedAt).toBe(now.toISOString())
    // keyword_hits gets each keyword with hit_count=1
    const hits = keywordHits.getByTopic('ceramics')
    expect(hits).toHaveLength(4)
    for (const h of hits) expect(h.hitCount).toBe(1)
  })

  it('A4: LLM returns should_create=false → no DAOs called', async () => {
    const before = topicsDao.list().length
    const client = stubClient([{ content: JSON.stringify({ should_create: false }) }])
    await autoExpandTopicLibrary(
      ['random', 'scattered', 'words'],
      [],
      { topics: TOPICS, topicStats, keywordHits, topicsDao, client },
      { now },
      { enabled: true },
    )
    expect(topicsDao.list()).toHaveLength(before)
    expect(topicStats.all()).toEqual([])
  })

  it('A5: LLM slug collides with existing topic → reject, no double-insert', async () => {
    // The baseline migration seeds an `aviation` topic with 27 keywords.
    // We don't compare to TOPICS[0] fixture; instead we check the row in
    // DB before and after to confirm it was NOT mutated.
    const aviationBefore = topicsDao.get('aviation')
    expect(aviationBefore).not.toBeNull()
    const beforeKwCount = aviationBefore!.keywords.length
    const beforeDesc = aviationBefore!.description

    const client = stubClient([
      {
        content: JSON.stringify({
          should_create: true,
          name: 'aviation',
          keywords: ['different', 'keywords'],
          description: 'should be rejected',
        }),
      },
    ])
    await autoExpandTopicLibrary(
      ['different', 'keywords'],
      [],
      { topics: TOPICS, topicStats, keywordHits, topicsDao, client },
      { now },
      { enabled: true },
    )
    const aviationAfter = topicsDao.get('aviation')
    expect(aviationAfter?.keywords).toHaveLength(beforeKwCount)
    expect(aviationAfter?.description).toBe(beforeDesc)
    expect(topicStats.get('aviation')).toBeNull()
  })

  it('A6: LLM returns invalid slug → reject', async () => {
    const before = topicsDao.list().length
    const client = stubClient([
      {
        content: JSON.stringify({
          should_create: true,
          name: 'BAD slug!',
          keywords: ['pottery', 'kiln'],
          description: 'invalid slug',
        }),
      },
    ])
    await autoExpandTopicLibrary(
      ['pottery'],
      [],
      { topics: TOPICS, topicStats, keywordHits, topicsDao, client },
      { now },
      { enabled: true },
    )
    expect(topicsDao.list()).toHaveLength(before)
  })

  it('A7: LLM returns <2 keywords after cleanup → reject', async () => {
    const client = stubClient([
      {
        content: JSON.stringify({
          should_create: true,
          name: 'tiny_topic',
          keywords: ['ok', '5'],
          description: 'too few',
        }),
      },
    ])
    await autoExpandTopicLibrary(
      ['ok'],
      [],
      { topics: TOPICS, topicStats, keywordHits, topicsDao, client },
      { now },
      { enabled: true },
    )
    expect(topicsDao.get('tiny_topic')).toBeNull()
    expect(topicStats.all()).toEqual([])
  })

  it('A8: LLM client throws → swallow, no DAOs called, no re-throw', async () => {
    const before = topicsDao.list().length
    await expect(
      autoExpandTopicLibrary(
        ['pottery', 'ceramics'],
        [],
        { topics: TOPICS, topicStats, keywordHits, topicsDao, client: throwingClient() },
        { now },
        { enabled: true },
      ),
    ).resolves.toBeUndefined()
    expect(topicsDao.list()).toHaveLength(before)
    expect(topicStats.all()).toEqual([])
  })

  it('A9: matchTopic hits existing topic → only keyword_hits bumped, topic_stats untouched', async () => {
    // 'boeing' / '737' are in `aviation`; together 2/3=0.67 > 0.05 threshold.
    // Without an LLM client being called. We pass a stub that would throw if hit.
    const client = stubClient([])
    await autoExpandTopicLibrary(
      ['boeing', '737', 'aerospace'],
      [],
      { topics: TOPICS, topicStats, keywordHits, topicsDao, client },
      { now },
      { enabled: true },
    )
    // topic_stats must NOT be bumped (aviation was not adopted this session)
    expect(topicStats.get('aviation')).toBeNull()
    // keyword_hits must contain the shared subset
    const hits = keywordHits.getByTopic('aviation')
    const hitKw = hits.map((h) => h.keyword).sort()
    expect(hitKw).toContain('boeing')
    expect(hitKw).toContain('737')
    expect(hits.every((h) => h.hitCount === 1)).toBe(true)
  })

  it('A10: all summaryKeywords already in adoptedSlugs → filter empties newKeywords, returns early', async () => {
    const client = stubClient([]) // would throw if called
    // adoptedSlugs=['aviation'], all summaryKeywords are subset of aviation.keywords
    await autoExpandTopicLibrary(
      ['boeing', '737'],
      ['aviation'],
      { topics: TOPICS, topicStats, keywordHits, topicsDao, client },
      { now },
      { enabled: true },
    )
    expect(topicStats.all()).toEqual([])
    expect(keywordHits.getAll()).toEqual([])
  })

  it('A11: adopted topic + extra unmatched keywords → LLM path picks up the extras', async () => {
    // aviation already adopted, but session also mentions 'cockpit' which
    // is in aviation too — so all matched. Use a keyword that should
    // NOT match any existing topic instead.
    const client = stubClient([
      {
        content: JSON.stringify({
          should_create: true,
          name: 'ceramics',
          keywords: ['pottery', 'ceramics', 'kiln', 'glaze'],
          description: 'Ceramics',
        }),
      },
    ])
    await autoExpandTopicLibrary(
      // 'boeing' is adopted (in aviation), 'pottery'/'ceramics'/'kiln' are new
      ['boeing', 'pottery', 'ceramics', 'kiln'],
      ['aviation'],
      { topics: TOPICS, topicStats, keywordHits, topicsDao, client },
      { now },
      { enabled: true },
    )
    // adopted aviation NOT bumped (filter removed boeing from newKeywords)
    expect(topicStats.get('aviation')).toBeNull()
    // ceramics created via LLM
    expect(topicsDao.get('ceramics')).not.toBeNull()
    expect(topicStats.get('ceramics')?.discussionCount).toBe(1)
  })

  it('A12: matchTopic threshold=0.05 lets single-keyword borderline merge through', async () => {
    // Use a session with many keywords + only 1 shared:
    // ['extra0', 'extra1', ..., 'extra9', 'cockpit'] — 10 keywords,
    // 1 shared → score = 1/10 = 0.1 > 0.05 → MERGE.
    const client = stubClient([])
    const keywords = [
      'extra0',
      'extra1',
      'extra2',
      'extra3',
      'extra4',
      'extra5',
      'extra6',
      'extra7',
      'extra8',
      'extra9',
      'cockpit',
    ]
    await autoExpandTopicLibrary(
      keywords,
      [],
      { topics: TOPICS, topicStats, keywordHits, topicsDao, client },
      { now },
      { enabled: true },
    )
    // 1 shared keyword hits aviation
    const hits = keywordHits.getByTopic('aviation')
    expect(hits.map((h) => h.keyword)).toContain('cockpit')
    expect(topicStats.get('aviation')).toBeNull()
  })
})
