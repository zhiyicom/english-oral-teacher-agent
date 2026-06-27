import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Message, SystemBlock } from './types.js'

const DEBUG_DIR = join(process.cwd(), 'data', 'llm-debug')

function ensureDir(): void {
  if (process.env.DEBUG_LOG_LLM !== '1') return
  try {
    mkdirSync(DEBUG_DIR, { recursive: true })
  } catch {
    // ignore — directory may already exist
  }
}

// v1.0.1 diagnostic — used to track down "no reply" / empty-stream bugs.
// Each call appends one JSON line to data/llm-debug/diag-<session>-<id>.jsonl
// so server-side (turn.ts) and client-side (SessionPage) logs land in the
// same file and can be correlated by sessionId + turnIndex.
function diagFile(sessionId: string): string {
  return join(DEBUG_DIR, `diag-${sessionId.slice(0, 8)}.jsonl`)
}

function truncate(s: string, head: number, tail: number): string {
  if (s.length <= head + tail + 32) return s
  return `${s.slice(0, head)}…[${s.length - head - tail} chars omitted]…${s.slice(-tail)}`
}

export function logTurnDiagnostic(
  sessionId: string,
  turnIndex: number,
  phase: string,
  data: Record<string, unknown>,
): void {
  if (process.env.DEBUG_LOG_LLM !== '1') return
  ensureDir()
  const line = `${JSON.stringify({
    ts: new Date().toISOString(),
    src: 'server',
    session: sessionId,
    turn: turnIndex,
    phase,
    ...data,
  })}\n`
  try {
    appendFileSync(diagFile(sessionId), line, 'utf-8')
  } catch {
    // best-effort
  }
}

// Client posts here so web-side events land in the same JSONL file.
// Always rewrites the file (one event per call) — the client fires this
// at most once per turn.
export function logWebDiagnostic(sessionId: string, payload: Record<string, unknown>): void {
  if (process.env.DEBUG_LOG_LLM !== '1') return
  ensureDir()
  const line = `${JSON.stringify({
    ts: new Date().toISOString(),
    src: 'web',
    session: sessionId,
    ...payload,
  })}\n`
  try {
    appendFileSync(diagFile(sessionId), line, 'utf-8')
  } catch {
    // best-effort
  }
}

export function logLLMRequest(
  sessionId: string,
  turnIndex: number,
  systemBlocks: SystemBlock[],
  messages: Message[],
): void {
  if (process.env.DEBUG_LOG_LLM !== '1') return
  ensureDir()

  const now = new Date().toISOString().replace(/[:.]/g, '-')
  const file = join(DEBUG_DIR, `${now}_${sessionId.slice(0, 8)}_turn${turnIndex}.txt`)

  const lines: string[] = []
  lines.push(`=== LLM Request Log ===`)
  lines.push(`Time: ${new Date().toISOString()}`)
  lines.push(`Session: ${sessionId}`)
  lines.push(`Turn: ${turnIndex}`)
  lines.push(`Messages in history: ${messages.length}`)
  lines.push(``)

  // System prompt blocks
  lines.push(`--- SYSTEM BLOCKS (${systemBlocks.length}) ---`)
  for (let i = 0; i < systemBlocks.length; i++) {
    const block = systemBlocks[i]
    if (block && 'text' in block) {
      const cached = 'cache_control' in block && block.cache_control ? ' [CACHED]' : ''
      lines.push(`[Block ${i}${cached}]:`)
      lines.push(block.text)
      lines.push(``)
    }
  }

  // Message history
  lines.push(`--- MESSAGES (${messages.length}) ---`)
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg) {
      lines.push(`[${i}] ${msg.role}:`)
      lines.push(msg.content)
      lines.push(``)
    }
  }

  lines.push(`=== END ===`)

  try {
    appendFileSync(file, lines.join('\n'), 'utf-8')
  } catch {
    // Best-effort — don't crash the turn on logging failure
  }
}

export function logSummarize(
  sessionId: string,
  messageCount: number,
  result: { summary: string; keywords: string[] },
): void {
  if (process.env.DEBUG_LOG_LLM !== '1') return
  ensureDir()
  const now = new Date().toISOString().replace(/[:.]/g, '-')
  const file = join(DEBUG_DIR, `${now}_${sessionId.slice(0, 8)}_summarize.txt`)

  const lines = [
    `=== Summarize Result ===`,
    `Time: ${new Date().toISOString()}`,
    `Session: ${sessionId}`,
    `Messages summarized: ${messageCount}`,
    ``,
    `Summary: ${result.summary}`,
    ``,
    `Keywords: ${result.keywords.join(', ')}`,
    ``,
    `=== END ===`,
  ]
  try {
    appendFileSync(file, lines.join('\n'), 'utf-8')
  } catch {
    // Best-effort
  }
}
