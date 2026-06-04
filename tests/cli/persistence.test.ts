import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  applyMigrations,
  createMessagesDao,
  createSessionsDao,
  openDb,
} from '../../src/storage/index.js'
import { resolveMigrationsDirForTesting } from '../storage/helpers.js'

const CLI_PATH = resolve('src/cli.ts')
const migrationsDir = resolveMigrationsDirForTesting()

interface RunResult {
  exitCode: number | null
  stdout: string
  stderr: string
}

function runCli(input: string, env: Record<string, string> = {}): Promise<RunResult> {
  return new Promise((res, rej) => {
    const child: ChildProcessWithoutNullStreams = spawn(
      process.execPath,
      ['--import', 'tsx', CLI_PATH],
      {
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )

    let stdout = ''
    let stderr = ''
    let teacherResponses = 0
    const targetResponses = input.split('\n').filter((l) => l.length > 0).length

    child.stdout.on('data', (d) => {
      stdout += d.toString()
      // Count [Teacher] markers as they arrive so we can close stdin only
      // after the CLI has finished all turns (avoids cutting off the last
      // streamed response on slow machines).
      const matches = stdout.match(/\[Teacher\]/g)
      if (matches && matches.length > teacherResponses) {
        teacherResponses = matches.length
        if (teacherResponses >= targetResponses) {
          // Give the loop a beat to write the trailing '\n\n' and return
          // to ask() before we end stdin. Without this, the empty-line
          // break path can win the race and skip the finally block on
          // some runs.
          setTimeout(() => child.stdin.end(), 300)
        }
      }
    })
    child.stderr.on('data', (d) => {
      stderr += d.toString()
    })
    child.on('error', rej)
    child.on('close', (code) => res({ exitCode: code, stdout, stderr }))

    setTimeout(() => {
      const lines = input.split('\n').filter((l) => l.length > 0)
      let i = 0
      const writeNext = () => {
        if (i >= lines.length) return
        child.stdin.write(`${lines[i]}\n`)
        i += 1
        setTimeout(writeNext, 700)
      }
      writeNext()
    }, 200)
  })
}

function safeRm(dir: string): void {
  for (let i = 0; i < 3; i++) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      return
    } catch (err) {
      if (i === 2) {
        console.warn(`[persistence.test] cleanup warning: ${(err as Error).message}`)
        return
      }
    }
  }
}

describe('CLI persistence (5 turns → DB readable from parent)', () => {
  let dataDir: string

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cli-persist-'))
  })
  afterEach(() => {
    safeRm(dataDir)
  })

  it('persists 5 turns of conversation to SQLite', async () => {
    const inputs = [
      'hi',
      'i am fine thanks',
      'i played minecraft',
      'i built castles and farms',
      'creepers blew them up',
    ]

    const result = await runCli(`${inputs.join('\n')}\n`, {
      MINIMAX_API_KEY: 'sk-test',
      RUN_LIVE_LLM: '0',
      APP_DATA_DIR: dataDir,
    })

    expect(result.exitCode).toBe(0)
    if (process.env.PERSIST_TEST_DEBUG) {
      console.log(`---STDOUT---\n${result.stdout}`)
      console.log(`---STDERR---\n${result.stderr}`)
    }
    expect(result.stdout).toMatch(/\[Teacher\]/)
    const teacherCount = (result.stdout.match(/\[Teacher\]/g) ?? []).length
    expect(teacherCount).toBe(5)

    // Open a fresh DB connection from the parent process — semantically
    // equivalent to "restart the CLI and query the DB".
    const db = openDb({ dataDir })
    applyMigrations(db, migrationsDir)
    const sessions = createSessionsDao(db)
    const messages = createMessagesDao(db)

    const allSessions = sessions.list()
    if (process.env.PERSIST_TEST_DEBUG) {
      console.log('---ALL SESSIONS---', JSON.stringify(allSessions, null, 2))
    }
    expect(allSessions).toHaveLength(1)
    expect(allSessions[0]?.ended_at).not.toBeNull()
    expect(allSessions[0]?.duration_min).not.toBeNull()
    expect(allSessions[0]?.duration_min).toBeGreaterThanOrEqual(0)

    const sessionId = allSessions[0]?.id ?? ''
    const msgs = messages.getBySession(sessionId)
    expect(msgs).toHaveLength(10)
    expect(msgs.filter((m) => m.role === 'user')).toHaveLength(5)
    expect(msgs.filter((m) => m.role === 'assistant')).toHaveLength(5)

    const userContents = msgs.filter((m) => m.role === 'user').map((m) => m.content)
    expect(userContents).toEqual(inputs)

    // Every assistant reply must have non-empty content (proves Replay responses
    // were actually written to the DB, not just printed and lost).
    const assistantTexts = msgs.filter((m) => m.role === 'assistant').map((m) => m.content)
    expect(assistantTexts.every((t) => t.length > 0)).toBe(true)

    // Messages should be in ts ASC order
    const timestamps = msgs.map((m) => m.ts)
    const sorted = [...timestamps].sort()
    expect(timestamps).toEqual(sorted)

    db.close()
  }, 25000)
})
