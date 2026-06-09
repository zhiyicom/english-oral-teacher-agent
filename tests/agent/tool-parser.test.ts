import { describe, expect, it } from 'vitest'
import { parseToolCall, stripToolCall } from '../../src/agent/tool-parser.js'

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
