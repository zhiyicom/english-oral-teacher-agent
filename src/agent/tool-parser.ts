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

// ----- v1.1.2: system-note echo stripper ---------------------------------
//
// Parallel to stripEchoedPhasePrefix above. The LLM occasionally invents
// a leading "[System note: you must call topic_select now. ...]" prefix
// when it tries to self-narrate the [System Context] reminder (observed
// in 2026-07-16 session 7132fcc9 — 7 occurrences in 14 minutes).
// Confirm-not-prompt-injection check: a `grep "\[System note:"` in src/
// returns 0 hits (PRD.md mentions "System note" semantics but uses a
// different literal); the LLM constructs these strings itself when it
// gets stuck, then either prepends them or follows them with a real
// <tool>topic_select(...)</tool> block.
//
// The 4 observed shapes are all covered by `[^\]]*\]\s*`:
//   1. "[System note: ...] Hey Jeremy"          (followed by real text)
//   2. "[System note: ...]\n\n<tool>...</tool>" (followed by tool call,
//                                                handled by parseToolCall
//                                                after strip)
//   3. "[System note: ...]"                     (just the note, nothing
//                                                else — cleaned = "")
//   4. Very short, "[System note: must call X.]" (LLM terseness variant)
//
// Order with stripEchoedPhasePrefix: System note first, Phase second.
// Unobserved in practice but future-safe — if LLM ever nests
// "[System note: now is [Phase: MAIN_ACTIVITY]]" the outer [System note: ...
// ] strip leaves the inner phase prefix for the next pass.
// `^` anchor so a mid-sentence "system note" mention never triggers.

const ECHOED_SYSTEM_NOTE_PREFIX = /^\[System note:[^\]]*\]\s*/

export function stripEchoedSystemNote(response: string): {
  cleaned: string
  stripped: boolean
} {
  const m = response.match(ECHOED_SYSTEM_NOTE_PREFIX)
  if (!m) return { cleaned: response, stripped: false }
  return { cleaned: response.slice(m[0].length).trim(), stripped: true }
}

// ----- v1.1.2 §1.5: markdown code-fence stripper -------------------------
//
// The LLM sometimes wraps <tool>...</tool> in ``` fences because the
// tools.md prompt (pre-v1.1.2-fix) showed examples inside fences with
// "output EXACTLY this block". When parseToolCall matches the <tool> inside
// the fences and stripToolCall removes only the <tool> tag, the bare ```
// fences remain and leak to the student UI.
//
// stripCodeFences removes leading ``` (with optional language tag) and
// trailing ``` before any other processing, so the tool call inside is
// extracted cleanly and no backtick garbage reaches the student.
//
// Only strips fence markers on their own line — inline backticks like
// `word` are not touched.

// Matches a standalone ``` fence line (with optional language tag), with
// optional leading/trailing whitespace on the line. Only matches when the
// fence marker is the only thing on its line (plus optional language tag).
// Does NOT match inline backticks like `word`.
const FENCE_LINE = /^[ \t]*```(?:\w+)?[ \t]*\n/gm

export function stripCodeFences(response: string): string {
  let s = response.replace(FENCE_LINE, '')
  // Also handle trailing ``` at end of string (no newline after it).
  s = s.replace(/^[ \t]*```[ \t]*$/gm, '')
  return s.replace(/\n{3,}/g, '\n\n').trim()
}
