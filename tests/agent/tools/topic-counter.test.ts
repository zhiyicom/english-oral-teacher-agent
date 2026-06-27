import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_MIN_TOPIC_AGE,
  deleteTopicTurnCount,
  getCurrentMinTopicAge,
  getTopicTurnCount,
  incrementTopicTurnCount,
  isExplicitTopicSwitch,
  resetTopicTurnCount,
} from '../../../src/agent/topic-counter.js'

describe('topic-counter', () => {
  const sessionA = 'session-A'
  const sessionB = 'session-B'

  afterEach(() => {
    deleteTopicTurnCount(sessionA)
    deleteTopicTurnCount(sessionB)
  })

  describe('incrementTopicTurnCount', () => {
    it('starts at 0 for an unseen session and increments by 1', () => {
      expect(getTopicTurnCount(sessionA)).toBe(0)
      expect(incrementTopicTurnCount(sessionA)).toBe(1)
      expect(incrementTopicTurnCount(sessionA)).toBe(2)
      expect(getTopicTurnCount(sessionA)).toBe(2)
    })

    it('keeps counters independent across sessions', () => {
      incrementTopicTurnCount(sessionA)
      incrementTopicTurnCount(sessionA)
      incrementTopicTurnCount(sessionB)
      expect(getTopicTurnCount(sessionA)).toBe(2)
      expect(getTopicTurnCount(sessionB)).toBe(1)
    })
  })

  describe('resetTopicTurnCount', () => {
    it('resets the counter to 0', () => {
      incrementTopicTurnCount(sessionA)
      incrementTopicTurnCount(sessionA)
      incrementTopicTurnCount(sessionA)
      resetTopicTurnCount(sessionA)
      expect(getTopicTurnCount(sessionA)).toBe(0)
    })
  })
})

describe('isExplicitTopicSwitch', () => {
  it.each([
    ['switch topic', true],
    ['Switch topic please', true],
    ['can we change topic', true],
    ['try a new topic', true],
    ['pick another topic', true],
    ['换个话题', true],
    ['我想换个话题', true],
    ['换个新话题', true],
    ['stupid questions', false],
    ['you asked me before', false],
    ['pick a topic', false],
    ['topic of the day', false], // "topic" without preceding keyword
    ['topics are hard', false],
    ['好无聊啊', false],
  ])('"%s" → %s', (input, expected) => {
    expect(isExplicitTopicSwitch(input)).toBe(expected)
  })
})

describe('getCurrentMinTopicAge', () => {
  const original = process.env.TOPIC_AGE_MIN

  afterEach(() => {
    if (original === undefined) delete process.env.TOPIC_AGE_MIN
    else process.env.TOPIC_AGE_MIN = original
  })

  it('returns DEFAULT_MIN_TOPIC_AGE (5) when env var is unset', () => {
    delete process.env.TOPIC_AGE_MIN
    expect(getCurrentMinTopicAge()).toBe(DEFAULT_MIN_TOPIC_AGE)
    expect(DEFAULT_MIN_TOPIC_AGE).toBe(5)
  })

  it('returns the env var value when set to a non-negative integer', () => {
    process.env.TOPIC_AGE_MIN = '0'
    expect(getCurrentMinTopicAge()).toBe(0)
    process.env.TOPIC_AGE_MIN = '10'
    expect(getCurrentMinTopicAge()).toBe(10)
  })

  it('falls back to DEFAULT_MIN_TOPIC_AGE for invalid env values', () => {
    process.env.TOPIC_AGE_MIN = 'not-a-number'
    expect(getCurrentMinTopicAge()).toBe(DEFAULT_MIN_TOPIC_AGE)
    process.env.TOPIC_AGE_MIN = '-3'
    expect(getCurrentMinTopicAge()).toBe(DEFAULT_MIN_TOPIC_AGE)
  })
})