import { describe, expect, it } from 'vitest'
import {
  estimateMessagesTokens,
  estimateTokens,
  truncateHistory,
} from '../../src/agent/truncate-history.js'
import type { Message } from '../../src/llm/types.js'

function msg(role: 'user' | 'assistant', content: string): Message {
  return { role, content }
}

// 50-char content → est 13 tokens (50/4 = 12.5 → ceil 13)
const SMALL = 'x'.repeat(50)

describe('estimateTokens', () => {
  it('1 token ≈ 4 chars: 50 chars → 13 tokens', () => {
    expect(estimateTokens('x'.repeat(50))).toBe(13)
  })
  it('empty string → 0 tokens', () => {
    expect(estimateTokens('')).toBe(0)
  })
  it('1 char → 1 token (ceil)', () => {
    expect(estimateTokens('a')).toBe(1)
  })
})

describe('estimateMessagesTokens', () => {
  it('sums content across all messages', () => {
    const msgs = [msg('user', 'x'.repeat(40)), msg('assistant', 'x'.repeat(80))]
    // 40/4 + 80/4 = 10 + 20 = 30
    expect(estimateMessagesTokens(msgs)).toBe(30)
  })
  it('empty array → 0', () => {
    expect(estimateMessagesTokens([])).toBe(0)
  })
})

describe('truncateHistory', () => {
  it('1. under budget → unchanged', () => {
    // 4 msgs × 50 chars = 200 chars = 50 tokens est; budget 100 → under
    const msgs = [
      msg('user', SMALL),
      msg('assistant', SMALL),
      msg('user', SMALL),
      msg('assistant', SMALL),
    ]
    const r = truncateHistory(msgs, 100)
    expect(r.dropped).toBe(0)
    expect(r.messages).toEqual(msgs)
  })

  it('2. over budget → drop oldest pairs in 2-message increments', () => {
    // 8 msgs × 50 chars → 50/4 = 13 tokens each → 8 × 13 = 104 tokens est.
    // budget 55: 6 msgs = 78 (over), 4 msgs = 52 (under) → drop 2 pairs.
    const msgs = [
      msg('user', SMALL),
      msg('assistant', SMALL),
      msg('user', SMALL),
      msg('assistant', SMALL),
      msg('user', SMALL),
      msg('assistant', SMALL),
      msg('user', SMALL),
      msg('assistant', SMALL),
    ]
    const r = truncateHistory(msgs, 55)
    expect(r.dropped).toBe(2)
    expect(r.messages).toHaveLength(4)
    // First remaining is msgs[4] (third user turn)
    expect(r.messages[0]).toBe(msgs[4])
  })

  it('3. always keep at least 2 messages (most recent pair), even if over budget', () => {
    // 6 msgs × 1000 chars = 6000 chars = 1500 tokens est; budget 1 → drop 2 pairs
    const big = 'y'.repeat(1000)
    const msgs = [
      msg('user', big),
      msg('assistant', big),
      msg('user', big),
      msg('assistant', big),
      msg('user', big),
      msg('assistant', big),
    ]
    const r = truncateHistory(msgs, 1)
    expect(r.dropped).toBe(2)
    expect(r.messages).toHaveLength(2)
    // Last pair preserved
    expect(r.messages[0]).toBe(msgs[4])
    expect(r.messages[1]).toBe(msgs[5])
  })

  it('4. empty history → unchanged', () => {
    const r = truncateHistory([], 100)
    expect(r.messages).toEqual([])
    expect(r.dropped).toBe(0)
  })

  it('5. systemSize is included in estimate (triggers earlier)', () => {
    // 4 msgs × 40 chars = 160 chars = 40 tokens est; budget 50.
    // Without systemSize → 40 ≤ 50, no truncate.
    // With systemSize=20 → 40 + 20 = 60 > 50, drop 1 pair.
    const msgs = [
      msg('user', 'a'.repeat(40)),
      msg('assistant', 'b'.repeat(40)),
      msg('user', 'c'.repeat(40)),
      msg('assistant', 'd'.repeat(40)),
    ]
    expect(truncateHistory(msgs, 50, 0).dropped).toBe(0)
    expect(truncateHistory(msgs, 50, 20).dropped).toBe(1)
  })
})
