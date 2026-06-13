import { describe, expect, it } from 'vitest'
import {
  TopicSelectArgsSchema,
  createTopicSelectTool,
} from '../../../src/agent/tools/topic-select.js'
import type { Topic, TopicStat } from '../../../src/storage/topics.js'

const NOW = new Date('2026-06-10T12:00:00.000Z')
const DAY = 86_400_000

function topic(name: string, keywords: string[]): Topic {
  return { name, keywords, description: null, createdAt: '2026-06-01T00:00:00.000Z' }
}

function stat(name: string, count: number, daysAgo: number | null): TopicStat {
  return {
    topic: name,
    discussionCount: count,
    firstDiscussedAt:
      daysAgo === null ? null : new Date(NOW.getTime() - daysAgo * DAY).toISOString(),
    lastDiscussedAt:
      daysAgo === null ? null : new Date(NOW.getTime() - daysAgo * DAY).toISOString(),
  }
}

const minecraft = topic('minecraft', ['minecraft', 'castle', 'creeper'])
const school = topic('school', ['school', 'class', 'teacher'])
const sports = topic('sports', ['soccer', 'ball', 'team'])

describe('TopicSelectArgsSchema', () => {
  it('accepts a minimal call with only phase omitted (defaulted)', () => {
    const parsed = TopicSelectArgsSchema.parse({})
    expect(parsed.phase).toBe('WARM_UP')
    expect(parsed.exclude_recent_days).toBe(30)
  })

  it('rejects an unknown phase value', () => {
    expect(() => TopicSelectArgsSchema.parse({ phase: 'NOT_A_PHASE' })).toThrow()
  })

  it('rejects negative exclude_recent_days', () => {
    expect(() => TopicSelectArgsSchema.parse({ exclude_recent_days: -1 })).toThrow()
  })
})

describe('createTopicSelectTool', () => {
  it('returns a typed TopicSelectResult when a winner exists', () => {
    const tool = createTopicSelectTool({
      topics: [minecraft, school, sports],
      stats: [],
      interests: ['minecraft', 'castle'],
      rng: () => 0.5, // noise=0, makes the test deterministic
    })
    const result = tool.execute({ phase: 'MAIN_ACTIVITY', exclude_recent_days: 30 }) as
      | {
          slug: string
          title: string
          est_minutes: number
        }
      | { error: string }
    expect(typeof result).toBe('object')
    if ('error' in result) throw new Error(`expected success, got error: ${result.error}`)
    expect(result.slug).toBeTruthy()
    expect(result.title).toBe(result.slug)
    expect(result.est_minutes).toBe(15)
  })

  it('returns { error } when hard exclude removes every topic', () => {
    // all 3 topics discussed within 30 days → no candidates
    const stats: TopicStat[] = [
      stat('minecraft', 1, 5),
      stat('school', 1, 10),
      stat('sports', 1, 20),
    ]
    const tool = createTopicSelectTool({
      topics: [minecraft, school, sports],
      stats,
      interests: [],
      rng: () => 0.5,
    })
    const result = tool.execute({ phase: 'WARM_UP', exclude_recent_days: 30 })
    expect(result).toEqual({ error: 'No topics available after hard exclude' })
  })

  it('schema validation throws on bad input (zod reaches the execute body)', () => {
    const tool = createTopicSelectTool({
      topics: [minecraft, school, sports],
      stats: [],
      interests: [],
    })
    expect(() => tool.execute({ phase: 'BOGUS' })).toThrow()
  })

  it('tool name and description are exposed for the registry / LLM tool listing', () => {
    const tool = createTopicSelectTool({ topics: [minecraft], stats: [], interests: [] })
    expect(tool.name).toBe('topic_select')
    expect(tool.description).toContain('topic')
  })
})
