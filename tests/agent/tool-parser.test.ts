import { describe, expect, it } from 'vitest'
import {
  parseBracketToolCall,
  parseToolCall,
  stripBracketToolCall,
  stripCodeFences,
  stripEchoedPhasePrefix,
  stripEchoedSystemNote,
  stripToolCall,
} from '../../src/agent/tool-parser.js'

describe('parseToolCall (v0.7 L1)', () => {
  it('parses a well-formed call and returns name/args/rawMatch', () => {
    const text =
      'Good try! <tool>mark_mistake({"original":"I go","corrected":"I went","category":"grammar"})</tool> Keep going.'
    const parsed = parseToolCall(text)
    expect(parsed).not.toBeNull()
    expect(parsed?.name).toBe('mark_mistake')
    expect(parsed?.args).toEqual({
      original: 'I go',
      corrected: 'I went',
      category: 'grammar',
    })
    expect(parsed?.rawMatch).toContain('<tool>')
    expect(parsed?.rawMatch).toContain('</tool>')
  })

  it('returns null when there is no tool block', () => {
    expect(parseToolCall('just some plain teacher reply')).toBeNull()
  })

  it('returns null when the open tag has no matching close tag', () => {
    expect(parseToolCall('say <tool>mark_mistake({"a":1}) without closer')).toBeNull()
  })

  it('throws when the JSON body is malformed', () => {
    expect(() => parseToolCall('<tool>mark_mistake({not valid json})</tool>')).toThrow(
      /JSON parse failed/i,
    )
  })

  it('returns null when the body is not a `{...}` block (regex never matches)', () => {
    // Array body: regex requires { ... }, so this doesn't match at all.
    expect(parseToolCall('<tool>mark_mistake([1,2,3])</tool>')).toBeNull()
    // Empty object body parses fine and is a valid (empty) record.
    const parsed = parseToolCall('<tool>mark_mistake({})</tool>')
    expect(parsed?.args).toEqual({})
  })

  it('takes only the first tool block when the LLM emits two', () => {
    const text = '<tool>a({"x":1})</tool> chatter <tool>b({"y":2})</tool>'
    const parsed = parseToolCall(text)
    expect(parsed?.name).toBe('a')
    expect(parsed?.args).toEqual({ x: 1 })
  })

  it('parses a tool block that spans multiple lines', () => {
    const text = `<tool>mark_mistake({
  "original": "I go",
  "corrected": "I went",
  "category": "grammar"
})</tool>`
    const parsed = parseToolCall(text)
    expect(parsed?.name).toBe('mark_mistake')
    expect(parsed?.args).toEqual({
      original: 'I go',
      corrected: 'I went',
      category: 'grammar',
    })
  })

  it('allows extra string fields the schema may not know about (pass-through)', () => {
    const text =
      '<tool>mark_mistake({"original":"a","corrected":"b","category":"grammar","note":"extra"})</tool>'
    const parsed = parseToolCall(text)
    expect(parsed?.args).toMatchObject({ note: 'extra' })
  })
})

describe('stripToolCall (v0.7 L1)', () => {
  it('removes the exact rawMatch block from the response', () => {
    const text = 'Hi <tool>mark_mistake({"x":1})</tool> there'
    const parsed = parseToolCall(text)
    if (!parsed) throw new Error('expected parse')
    const stripped = stripToolCall(text, parsed)
    expect(stripped).toBe('Hi  there'.trim())
    expect(stripped).not.toContain('<tool>')
  })

  it('collapses left-over blank lines after stripping', () => {
    const text = 'First line\n\n<tool>mark_mistake({"x":1})</tool>\n\nThird line'
    const parsed = parseToolCall(text)
    if (!parsed) throw new Error('expected parse')
    const stripped = stripToolCall(text, parsed)
    expect(stripped).toBe('First line\n\nThird line')
  })

  it('trims leading/trailing whitespace from the stripped result', () => {
    const text = '<tool>mark_mistake({"x":1})</tool>\n\nHello'
    const parsed = parseToolCall(text)
    if (!parsed) throw new Error('expected parse')
    expect(stripToolCall(text, parsed)).toBe('Hello')
  })
})

describe('parseBracketToolCall (v1.1.1 P0-#2)', () => {
  it('B1: parses a complete bracket-form tool call', () => {
    const text =
      '[Tool call: topic_select]\n{"phase":"MAIN_ACTIVITY","exclude_recent_days":30}'
    const parsed = parseBracketToolCall(text)
    expect(parsed).not.toBeNull()
    expect(parsed?.name).toBe('topic_select')
    expect(parsed?.args).toEqual({
      phase: 'MAIN_ACTIVITY',
      exclude_recent_days: 30,
    })
    expect(parsed?.rawMatch).toContain('[Tool call:')
  })

  it('B2: returns null when bracket form has no JSON body', () => {
    expect(parseBracketToolCall('[Tool call: topic_select]')).toBeNull()
  })

  it('B3: returns null (does not throw) when JSON body is malformed', () => {
    // LLM forgot the closing brace — must NOT throw, just return null so
    // the caller's defensive strip can still take over.
    expect(parseBracketToolCall('[Tool call: topic_select]\n{garbage')).toBeNull()
    expect(parseBracketToolCall('[Tool call: name]\n{"k": "v"')).toBeNull()
  })

  it('B4: stripBracketToolCall removes bracket prefix + JSON body', () => {
    const text =
      '[Tool call: topic_select]\n{"phase":"MAIN_ACTIVITY","exclude_recent_days":30}\n后续文本'
    expect(stripBracketToolCall(text)).toBe('后续文本')
  })

  it('B5: stripBracketToolCall returns the input unchanged when no bracket prefix', () => {
    expect(stripBracketToolCall('Hey Jeremy')).toBe('Hey Jeremy')
    expect(stripBracketToolCall('Just a normal teacher reply')).toBe('Just a normal teacher reply')
  })

  it('B6: <tool> form is still preferred — existing tests do not regress', () => {
    // The primary parser must still take precedence when both forms appear
    // (even though our LLM never emits both, the original 8 parseToolCall
    // tests above already lock this in).
    const text =
      '<tool>mark_mistake({"original":"a","corrected":"b","category":"grammar"})</tool>'
    const parsed = parseToolCall(text)
    expect(parsed?.name).toBe('mark_mistake')
    expect(parseBracketToolCall(text)).toBeNull()
  })

  it('B7: bracket in the middle of text does not match (^...$ anchor)', () => {
    expect(parseBracketToolCall('Hey [Tool call: name] how are you?')).toBeNull()
    expect(stripBracketToolCall('Hey [Tool call: name] how are you?')).toBe(
      'Hey [Tool call: name] how are you?',
    )
  })

  it('B8: name with non-word characters (e.g. hyphen) does not match', () => {
    expect(parseBracketToolCall('[Tool call: my-tool]\n{"x":1}')).toBeNull()
    expect(parseBracketToolCall('[Tool call: foo.bar]\n{"x":1}')).toBeNull()
  })

  it('stripBracketToolCall also strips when JSON body is malformed', () => {
    // Defensive path: even when parseBracketToolCall returns null, the
    // strip should still remove the prefix so the UI never sees it.
    const text = '[Tool call: topic_select]\n{garbage not json}\nHey Jeremy'
    expect(stripBracketToolCall(text)).toBe('Hey Jeremy')
  })
})

describe('stripEchoedPhasePrefix (v1.1.1 P0-#4)', () => {
  it('P1: strips a single-line "[Phase: ...]" prefix', () => {
    const r = stripEchoedPhasePrefix(
      '[Phase: MAIN_ACTIVITY — CALL `topic_select` TOOL to pick next topic] Hey Jeremy',
    )
    expect(r.stripped).toBe(true)
    expect(r.cleaned).toBe('Hey Jeremy')
  })

  it('P2: returns the input unchanged when no prefix is present', () => {
    const r = stripEchoedPhasePrefix('Hey Jeremy')
    expect(r.stripped).toBe(false)
    expect(r.cleaned).toBe('Hey Jeremy')
  })

  it('P3: strips multi-line prefix (matches the observed MAIN_ACTIVITY ---] form)', () => {
    // Mirrors the 7/15 rawHead:
    //   "[Phase: MAIN_ACTIVITY — ... 25 min\n\n---] I talked to you last time."
    const r = stripEchoedPhasePrefix(
      '[Phase: MAIN_ACTIVITY — CALL `topic_select` TOOL to pick next topic (NEVER pick from `# STUDENT` interests directly) — teach vocab, student talks 70%, NEVER end before 25 min\n\n---] I talked to you last time.',
    )
    expect(r.stripped).toBe(true)
    expect(r.cleaned).toBe('I talked to you last time.')
  })

  it('P3b: strips the observed END-phase prefix', () => {
    const r = stripEchoedPhasePrefix(
      '[Phase: END — Time remaining: 0.0 min — NO more questions. End the session now.]\n\nBye Jeremy, see you next time!',
    )
    expect(r.stripped).toBe(true)
    expect(r.cleaned).toBe('Bye Jeremy, see you next time!')
  })

  it('P4: does not strip a mid-sentence "[Phase: x]" (^ anchor)', () => {
    // Defends against false positives where a teacher reply uses the
    // literal word "phase" mid-sentence.
    const text = 'I noticed we changed phase. Want to keep going?'
    const r = stripEchoedPhasePrefix(text)
    expect(r.stripped).toBe(false)
    expect(r.cleaned).toBe(text)
  })
})

describe('stripEchoedSystemNote (v1.1.2 P0-α — parallel to stripEchoedPhasePrefix)', () => {
  // v1.1.2 P0-α — LLM self-narrated "[System note: ...]" prefixes observed
  // 7× in 7/16 session 7132fcc9 (when LLM gets stuck and tries to restate
  // the [System Context] reminder in its own words). Order with
  // stripEchoedPhasePrefix: System note first, Phase second (defensive
  // future-proofing for nested brackets).

  it('S1: strips a single-line "[System note: ...]" prefix', () => {
    const r = stripEchoedSystemNote(
      '[System note: you must call topic_select now. The student is stuck.] Hey Jeremy',
    )
    expect(r.stripped).toBe(true)
    expect(r.cleaned).toBe('Hey Jeremy')
  })

  it('S2: returns the input unchanged when no prefix is present', () => {
    const r = stripEchoedSystemNote('Hey Jeremy')
    expect(r.stripped).toBe(false)
    expect(r.cleaned).toBe('Hey Jeremy')
  })

  it('S3: strips a multi-line prefix ending with the closing bracket', () => {
    const r = stripEchoedSystemNote(
      '[System note: must call topic_select — student gave a 1-word answer.\nThis is the 3rd short reply in a row.]\nNice, playing with friends.',
    )
    expect(r.stripped).toBe(true)
    expect(r.cleaned).toBe('Nice, playing with friends.')
  })

  it('S4: does not strip a mid-sentence "[System note: x]" (^ anchor)', () => {
    // Defends against false positives where a teacher reply uses the
    // literal phrase "system note" mid-sentence (unlikely but possible).
    const text = 'Just a friendly system note for you: keep going!'
    const r = stripEchoedSystemNote(text)
    expect(r.stripped).toBe(false)
    expect(r.cleaned).toBe(text)
  })
})

// ----- v1.1.2 §1.5: stripCodeFences ----------------------------------------

describe('stripCodeFences (v1.1.2 P0-B — code fence strip)', () => {
  it('F1: strips leading + trailing ``` fences, keeps inner content', () => {
    const input = '```\n<tool>topic_select({"phase":"MAIN_ACTIVITY"})</tool>\n```'
    const result = stripCodeFences(input)
    expect(result).toBe('<tool>topic_select({"phase":"MAIN_ACTIVITY"})</tool>')
  })

  it('F2: strips fences with language tag', () => {
    const input = '```json\n{"key":"value"}\n```'
    const result = stripCodeFences(input)
    expect(result).toBe('{"key":"value"}')
  })

  it('F3: no-op on plain text without fences', () => {
    const input = 'Hey Jeremy, how are you?'
    const result = stripCodeFences(input)
    expect(result).toBe(input)
  })

  it('F4: does not touch inline backticks', () => {
    const input = 'I like `pizza` and `pasta`'
    const result = stripCodeFences(input)
    expect(result).toBe(input)
  })

  it('F5: strips fences when natural text precedes tool call inside', () => {
    const input =
      'Sure, let me pick a fresh topic!\n\n```\n<tool>topic_select({"phase":"MAIN_ACTIVITY"})</tool>\n```'
    const result = stripCodeFences(input)
    expect(result).toBe(
      'Sure, let me pick a fresh topic!\n\n<tool>topic_select({"phase":"MAIN_ACTIVITY"})</tool>',
    )
  })
})
