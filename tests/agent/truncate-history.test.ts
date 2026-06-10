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
    expect(truncateHistory(msgs, 50, { systemSize: 0 }).dropped).toBe(0)
    expect(truncateHistory(msgs, 50, { systemSize: 20 }).dropped).toBe(1)
  })

  // -------- v0.7.6 B1 — anchor pair --------

  it('6. anchor pair at head: protected prefix is never dropped, even if it would otherwise fit', () => {
    // 4 msgs × 50 chars = 50/4 = 13 tokens est each → 4 × 13 = 52 tokens.
    // budget 14: total 52 > 14, but the loop guard `current.length > 2`
    // prevents dropping the last pair from droppable.
    // With anchorPair = [m1, m2]: protectedHead=[m1, m2] (26 tokens),
    // droppable=[m3, m4] (2 messages, can't drop more — guard fires).
    // Anchor is preserved verbatim, droppable stays as-is.
    const m1 = msg('user', 'a'.repeat(50))
    const m2 = msg('assistant', 'b'.repeat(50))
    const m3 = msg('user', 'c'.repeat(50))
    const m4 = msg('assistant', 'd'.repeat(50))
    const r = truncateHistory([m1, m2, m3, m4], 14, {
      anchorPair: [m1, m2],
    })
    // 0 dropped (droppable already at min length of 2). Anchor preserved.
    expect(r.dropped).toBe(0)
    expect(r.messages).toHaveLength(4)
    expect(r.messages[0]).toBe(m1)
    expect(r.messages[1]).toBe(m2)
  })

  it('7. anchor pair: messages much larger than budget → only droppable middle gets truncated, anchor preserved + last pair preserved', () => {
    // 8 msgs of 1000 chars each (260 tokens est each = 2080 total). budget=300.
    // Anchor = msgs[0..1]. Droppable = msgs[2..7] (6 messages).
    // Loop: total = 8×260=2080 > 300, current.length=6 > 2, drop 1 pair.
    //   current=[m4, m5, m6, m7], total = 6×260=1560 > 300, drop 1 pair.
    //   current=[m6, m7], total = 4×260=1040 > 300, current.length=2 not > 2, exit.
    // Result: anchor (m0, m1) + droppable (m6, m7). dropped=2.
    const big = 'x'.repeat(1000)
    const m = Array.from({ length: 8 }, (_, i) =>
      msg(i % 2 === 0 ? 'user' : 'assistant', big),
    )
    const [a0, a1, , , , , b6, b7] = m
    if (!a0 || !a1 || !b6 || !b7) throw new Error('test setup: expected 8 messages')
    const r = truncateHistory(m, 300, { anchorPair: [a0, a1] })
    expect(r.dropped).toBe(2)
    expect(r.messages).toHaveLength(4)
    expect(r.messages[0]).toBe(m[0])
    expect(r.messages[1]).toBe(m[1])
    expect(r.messages[2]).toBe(m[6])
    expect(r.messages[3]).toBe(m[7])
  })

  it('8. anchor pair that does not match the head: silently falls back to v0.7.5 behavior', () => {
    // 4 msgs; anchor = different content. headMatches=false → droppable = all 4.
    // v0.7.5 behavior: drop pairs from the front until under budget OR
    // current.length ≤ 2.
    // 4 msgs × 50 chars = 52 tokens; budget 14.
    //   current.length=4 > 2, total 52 > 14, drop 1 pair.
    //   current=[m3, m4] (2 messages), total 26 > 14, but length=2, exit.
    // Result: dropped=1, messages=[m3, m4].
    const msgs = [
      msg('user', 'a'.repeat(50)),
      msg('assistant', 'b'.repeat(50)),
      msg('user', 'c'.repeat(50)),
      msg('assistant', 'd'.repeat(50)),
    ]
    const wrongAnchor = [msg('user', 'zzz'), msg('assistant', 'yyy')]
    const r = truncateHistory(msgs, 14, { anchorPair: wrongAnchor })
    expect(r.dropped).toBe(1)
    expect(r.messages).toHaveLength(2)
    // No part of the wrongAnchor should be in the result.
    expect(r.messages[0]?.content).toBe(msgs[2]?.content)
    expect(r.messages[1]?.content).toBe(msgs[3]?.content)
  })

  it('9. empty anchor pair: behaves identically to v0.7.5 (no anchor protection)', () => {
    const msgs = [
      msg('user', 'a'.repeat(50)),
      msg('assistant', 'b'.repeat(50)),
      msg('user', 'c'.repeat(50)),
      msg('assistant', 'd'.repeat(50)),
    ]
    const a = truncateHistory(msgs, 14, { anchorPair: [] })
    const b = truncateHistory(msgs, 14, {})
    expect(a.messages).toEqual(b.messages)
    expect(a.dropped).toBe(b.dropped)
  })

  it('10. anchor pair at the front, no truncation needed: messages returned verbatim', () => {
    const msgs = [
      msg('user', 'a'.repeat(40)),
      msg('assistant', 'b'.repeat(40)),
      msg('user', 'c'.repeat(40)),
      msg('assistant', 'd'.repeat(40)),
    ]
    const [a0, a1] = msgs
    if (!a0 || !a1) throw new Error('test setup: expected 4 messages')
    const r = truncateHistory(msgs, 200, { anchorPair: [a0, a1] })
    expect(r.dropped).toBe(0)
    expect(r.messages).toEqual(msgs)
  })
})
