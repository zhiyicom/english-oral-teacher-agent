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
