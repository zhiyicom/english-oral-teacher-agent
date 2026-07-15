/**
 * v0.7 tool-call parser for the custom text protocol.
 *
 * The LLM is taught (via prompts/tools.md) to emit a single block of the form
 *
 *   <tool>name({"k":"v",...})</tool>
 *
 * somewhere in its response. The CLI calls `parseToolCall` after the LLM
 * response has finished streaming (buffered), then `stripToolCall` to remove
 * the block before printing the assistant text to the student.
 *
 * Design choices:
 * - At most one tool per turn. We take the first match and ignore any more.
 * - JSON.parse failures throw — the caller (CLI) catches and logs.
 * - Tool name unknown → still returns ParsedToolCall; the caller decides
 *   what to do (log + skip, or fail). Keeps parsing decoupled from the
 *   registry.
 */

export interface ParsedToolCall {
  name: string
  args: Record<string, unknown>
  /** The exact substring (including the wrapping tags) that we matched. */
  rawMatch: string
}

// `[\s\S]` so the json body can span lines if the model decides to format it.
// Non-greedy on `\{...\}` keeps us to the first balanced-looking block.
const TOOL_REGEX = /<tool>(\w+)\(\s*(\{[\s\S]*?\})\s*\)<\/tool>/

export function parseToolCall(response: string): ParsedToolCall | null {
  const match = TOOL_REGEX.exec(response)
  if (!match) return null
  const [rawMatch, name, jsonStr] = match
  if (!name || !jsonStr) return null
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(jsonStr)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`tool args JSON parse failed for ${name}: ${msg}`)
  }
  if (typeof parsedJson !== 'object' || parsedJson === null || Array.isArray(parsedJson)) {
    throw new Error(`tool args for ${name} must be a JSON object, got ${typeof parsedJson}`)
  }
  return {
    name,
    args: parsedJson as Record<string, unknown>,
    rawMatch,
  }
}

/**
 * Remove the exact substring of a parsed tool call from the response.
 * Trims surrounding whitespace and collapses double-newlines so the
 * student-facing text doesn't get a weird blank gap.
 */
export function stripToolCall(response: string, parsed: ParsedToolCall): string {
  return response
    .replace(parsed.rawMatch, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// ----- v1.1.1: bracket-form fallback ------------------------------------
//
// When the LLM forgets the <tool>...</tool> wrapper, it sometimes emits
// "[Tool call: name]\n{json}" instead (observed in 2026-07-15 sessions).
// The primary parser above doesn't match this form; v1.1.1 adds:
//   - parseBracketToolCall: best-effort parser, returns null on any
//     failure (NEVER throws — bracket form is a fallback, not a contract).
//   - stripBracketToolCall: defensive strip of the bracket prefix even
//     when the JSON is malformed, so the student UI never sees the raw
//     "[Tool call: ...]" leak.

// `^...$` anchor so a stray "[Tool call: ...]" mid-sentence doesn't match.
// `\w+` for the name (same as <tool> form — no hyphens, no dots).
// Non-greedy JSON body so we stop at the first `}`.
const BRACKET_TOOL_REGEX = /^\[Tool call:\s*(\w+)\s*\]\s*(\{[\s\S]*?\})\s*$/

export function parseBracketToolCall(response: string): ParsedToolCall | null {
  const match = BRACKET_TOOL_REGEX.exec(response)
  if (!match) return null
  const [, name, jsonStr] = match
  if (!name || !jsonStr) return null
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(jsonStr)
  } catch {
    // v1.1.1 — bracket form is the LLM's fallback when it forgets <tool>.
    // Don't throw; treat as no parse so the caller can strip-and-display.
    return null
  }
  if (typeof parsedJson !== 'object' || parsedJson === null || Array.isArray(parsedJson)) {
    return null
  }
  return { name, args: parsedJson as Record<string, unknown>, rawMatch: match[0] }
}

// Strips a leading "[Tool call: name]\n{...}" prefix from the response.
// The JSON body is optional in the strip path so a malformed JSON still
// removes cleanly. Uses `^` anchor to avoid eating mid-sentence brackets.
const BRACKET_PREFIX_REGEX = /^\[Tool call:[^\]]*\]\s*(?:\{[\s\S]*?\})?\s*/

export function stripBracketToolCall(response: string): string {
  return response.replace(BRACKET_PREFIX_REGEX, '').trim()
}

// ----- v1.1.1: phase-prefix echo stripper -------------------------------
//
// The LLM occasionally paraphrases the [System Context] block (or the
// inline phase-reminder prefix prepended at turn.ts:569) as a leading
// "[Phase: PHASE — reminder]" line. We strip it defensively before
// parsing/pushing history so the student UI never sees the raw
// "[Phase: WRAP_UP — Time remaining: ~1.6 min — ...]" metadata.
//
// The regex matches both observed shapes:
//   "[Phase: MAIN_ACTIVITY — ... \n\n---]" (CRLF + --- separator)
//   "[Phase: END — ...]" (single-line, plain closing bracket)
//
// `[^\]]*` keeps us greedy-up-to-first-`]`, which is what we want:
// we don't want to match across the closing bracket into real content.

// `^` anchor so a mid-sentence "phase" mention never triggers.
const ECHOED_PHASE_PREFIX = /^\[Phase:[^\]]*\]\s*/

export function stripEchoedPhasePrefix(response: string): {
  cleaned: string
  stripped: boolean
} {
  const m = response.match(ECHOED_PHASE_PREFIX)
  if (!m) return { cleaned: response, stripped: false }
  return { cleaned: response.slice(m[0].length).trim(), stripped: true }
}
