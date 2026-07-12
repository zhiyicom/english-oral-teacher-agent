import { describe, expect, it } from 'vitest'
import { extractWarmUpKeywords } from '../../src/agent/turn.js'

// v1.0.9 §1.3 — `extractWarmUpKeywords` is the WARM_UP → topic_select
// bridge. It feeds contextKeywords into topic_select so the auto-injected
// MAIN_ACTIVITY topic can be soft-boosted toward what the student just
// talked about. Tests below pin the exact tokenization contract so
// changes here surface immediately.

describe('extractWarmUpKeywords (v1.0.9 §1.3)', () => {
  it('returns empty array for empty history', () => {
    expect(extractWarmUpKeywords([])).toEqual([])
  })

  it('extracts only user-role messages, skips assistant messages', () => {
    const history = [
      { role: 'assistant' as const, content: 'What did you do today?' },
      { role: 'user' as const, content: 'I played minecraft with friends.' },
    ]
    // 'I' (1 char) and 'a' from "play**ed**" — actually 'played' is 6 chars, kept.
    // Tokens from "I played minecraft with friends.":
    //   'i' (1 char, dropped), 'played' (6 chars, kept),
    //   'minecraft' (kept), 'with' (kept), 'friends' (kept).
    expect(extractWarmUpKeywords(history)).toEqual(['played', 'minecraft', 'with', 'friends'])
  })

  it('lowercases tokens and deduplicates case-insensitively', () => {
    const history = [
      { role: 'user' as const, content: 'Minecraft is fun. MINECRAFT castles!' },
    ]
    // 'minecraft' (case-insensitive dedup → kept once), 'is' (2 chars, dropped),
    // 'fun' (3 chars, kept), 'castles' (kept).
    expect(extractWarmUpKeywords(history)).toEqual(['minecraft', 'fun', 'castles'])
  })

  it('drops ASCII tokens shorter than 3 chars (a, an, to, I, ok, hi)', () => {
    const history = [
      { role: 'user' as const, content: 'I had a pizza and ok hi' },
    ]
    // 'I' (1), 'a' (1), 'ok' (2), 'hi' (2) filtered. 'had' (3), 'pizza' (5), 'and' (3) kept.
    expect(extractWarmUpKeywords(history)).toEqual(['had', 'pizza', 'and'])
  })

  it('drops pure-numeric tokens but keeps mixed alpha-numeric tokens like 3a', () => {
    const history = [
      { role: 'user' as const, content: 'class 3a has 25 students' },
    ]
    // Tokens: 'class' (5), '3a' (mixed, kept), 'has' (3), '25' (pure digits, dropped),
    // 'students' (8, kept).
    expect(extractWarmUpKeywords(history)).toEqual(['class', '3a', 'has', 'students'])
  })

  it('splits on punctuation, whitespace, and CJK punctuation; CJK runs stay as words', () => {
    const history = [
      { role: 'user' as const, content: '我昨天玩了 minecraft，波音 737 驾驶舱的视频。' },
    ]
    // `\p{L}` covers CJK characters, so CJK runs stay together (no
    // per-char split). CJK punctuation `，` and `。` ARE separators, and
    // the ASCII space + punctuation split at boundaries. Result:
    //   '我昨天玩了' (CJK 5-char run)
    //   'minecraft' (ASCII 9-char)
    //   '波音' (CJK 2-char — kept, length filter only applies to ASCII)
    //   '737' (pure numeric → dropped)
    //   '驾驶舱的视频' (CJK 6-char run)
    expect(extractWarmUpKeywords(history)).toEqual([
      '我昨天玩了',
      'minecraft',
      '波音',
      '驾驶舱的视频',
    ])
  })

  it('preserves order of first appearance across messages', () => {
    const history = [
      { role: 'user' as const, content: 'minecraft castle' },
      { role: 'assistant' as const, content: 'cool' }, // skipped
      { role: 'user' as const, content: 'then soccer with friends' },
    ]
    expect(extractWarmUpKeywords(history)).toEqual([
      'minecraft',
      'castle',
      'then',
      'soccer',
      'with',
      'friends',
    ])
  })

  it('caps output at 30 unique tokens', () => {
    // Generate 50 unique 4-char tokens so none trip the < 3 char filter.
    const tokens = Array.from({ length: 50 }, (_, i) => `tok${i.toString().padStart(2, '0')}`)
    const history = [{ role: 'user' as const, content: tokens.join(' ') }]
    const result = extractWarmUpKeywords(history)
    expect(result).toHaveLength(30)
    // First-in first-out: the first 30 tokens in input order.
    expect(result[0]).toBe('tok00')
    expect(result[29]).toBe('tok29')
  })

  it('handles only-assistant history by returning empty array', () => {
    const history = [
      { role: 'assistant' as const, content: 'minecraft castle creeper' },
    ]
    expect(extractWarmUpKeywords(history)).toEqual([])
  })

  it('treats empty content strings as no-op', () => {
    const history = [
      { role: 'user' as const, content: '' },
      { role: 'user' as const, content: '   ' },
      { role: 'user' as const, content: 'minecraft' },
    ]
    expect(extractWarmUpKeywords(history)).toEqual(['minecraft'])
  })
})