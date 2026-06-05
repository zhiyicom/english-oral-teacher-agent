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
      const matches = stdout.match(/\[Teacher\]/g)
      if (matches && matches.length > teacherResponses) {
        teacherResponses = matches.length
        if (teacherResponses >= targetResponses) {
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
        console.warn(`[cli-integration.test] cleanup warning: ${(err as Error).message}`)
        return
      }
    }
  }
}

describe('CLI v0.4 state-machine integration', () => {
  let dataDir: string

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cli-int-'))
  })
  afterEach(() => {
    safeRm(dataDir)
  })

  it('1 turn: stderr shows ctx: WARM_UP', async () => {
    const result = await runCli('hi\nexit\n', {
      MINIMAX_API_KEY: 'sk-test',
      APP_DATA_DIR: dataDir,
    })
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toMatch(/\[cli\] ctx: WARM_UP/)
    expect(result.stderr).toMatch(/elapsed=0\.0/)
  }, 20000)

  it('6 turns under MOCK_TIME: last ctx line shows MAIN_ACTIVITY', async () => {
    // Each turn advances the mock clock by 1 min; after 6 turns elapsed=6 → MAIN_ACTIVITY.
    // Use only inputs that have matching replay fixtures (hi, fine, castle, creeper, played).
    const inputs = ['hi', 'fine', 'castle', 'creeper', 'played', 'hi']
    const result = await runCli(`${inputs.join('\n')}\n`, {
      MINIMAX_API_KEY: 'sk-test',
      MOCK_TIME: '1',
      MOCK_NOW: '2026-01-01T00:00:00Z',
      APP_DATA_DIR: dataDir,
    })
    expect(result.exitCode).toBe(0)
    // Find all ctx lines and check the last one
    const ctxLines = result.stderr.split('\n').filter((l) => l.startsWith('[cli] ctx:'))
    expect(ctxLines.length).toBeGreaterThanOrEqual(6)
    const last = ctxLines[ctxLines.length - 1] ?? ''
    expect(last).toMatch(/\[cli\] ctx: MAIN_ACTIVITY/)
  }, 25000)

  it('5 turns: DB has phase_history (>= 1 transition recorded)', async () => {
    const inputs = ['hi', 'fine', 'castle', 'creeper', 'played']
    const result = await runCli(`${inputs.join('\n')}\n`, {
      MINIMAX_API_KEY: 'sk-test',
      APP_DATA_DIR: dataDir,
    })
    expect(result.exitCode).toBe(0)

    const db = openDb({ dataDir })
    applyMigrations(db, migrationsDir)
    const sessions = createSessionsDao(db)
    const all = sessions.list()
    expect(all).toHaveLength(1)
    expect(all[0]?.phase_history).not.toBeNull()
    const history = JSON.parse(all[0]?.phase_history ?? '[]')
    expect(Array.isArray(history)).toBe(true)
    expect(history.length).toBeGreaterThanOrEqual(1)
    // First entry is always WARM_UP@0
    expect(history[0]).toMatchObject({ phase: 'WARM_UP', at: 0, reason: 'time' })
    db.close()
  }, 25000)

  it('user says "stop": next ctx shows END + loop exits + DB has user_stop reason', async () => {
    const result = await runCli('hi\nstop\n', {
      MINIMAX_API_KEY: 'sk-test',
      APP_DATA_DIR: dataDir,
    })
    expect(result.exitCode).toBe(0)
    // Should have 2 [Teacher] responses (hi + stop goodbye)
    const teacherCount = (result.stdout.match(/\[Teacher\]/g) ?? []).length
    expect(teacherCount).toBe(2)
    // stderr should have ctx: WARM_UP for "hi" and ctx: END for "stop"
    const ctxLines = result.stderr.split('\n').filter((l) => l.startsWith('[cli] ctx:'))
    expect(ctxLines.length).toBeGreaterThanOrEqual(2)
    expect(ctxLines[0]).toMatch(/\[cli\] ctx: WARM_UP/)
    expect(ctxLines[1]).toMatch(/\[cli\] ctx: END/)
    // DB should have user_stop reason
    const db = openDb({ dataDir })
    applyMigrations(db, migrationsDir)
    const sessions = createSessionsDao(db)
    const all = sessions.list()
    expect(all[0]?.phase_history).not.toBeNull()
    const history = JSON.parse(all[0]?.phase_history ?? '[]')
    // Last entry should be END with reason user_stop
    const last = history[history.length - 1]
    expect(last).toMatchObject({ phase: 'END', reason: 'user_stop' })
    db.close()
  }, 20000)

  it('"okay stop" (mid-sentence) is NOT a stop; loop continues normally', async () => {
    // 'bye' would be a stop keyword, so use 'castle' (which has a fixture) for turn 3.
    const result = await runCli('hi\nokay stop then continue\ncastle\n', {
      MINIMAX_API_KEY: 'sk-test',
      APP_DATA_DIR: dataDir,
    })
    expect(result.exitCode).toBe(0)
    // 3 turns, no stop triggered
    const teacherCount = (result.stdout.match(/\[Teacher\]/g) ?? []).length
    expect(teacherCount).toBe(3)
    // No END in ctx lines
    const ctxLines = result.stderr.split('\n').filter((l) => l.startsWith('[cli] ctx:'))
    expect(ctxLines.every((l) => !l.includes('ctx: END'))).toBe(true)
  }, 20000)
})
