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
