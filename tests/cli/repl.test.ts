import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const CLI_PATH = resolve('src/cli.ts')

interface RunResult {
  exitCode: number | null
  stdout: string
  stderr: string
}

// v1.0.5.3 §1.3 — isolate the CLI's USER.md reads into a temp dir so the
// test doesn't depend on the developer's real profile or stale ./data/ files.
function runCli(input: string, env: Record<string, string> = {}): Promise<RunResult> {
  const dataDir = mkdtempSync(join(tmpdir(), 'repl-test-'))
  return new Promise((res, rej) => {
    const child: ChildProcessWithoutNullStreams = spawn(
      process.execPath,
      ['--import', 'tsx', CLI_PATH],
      {
        // v1.0.5.2 §1.2 — see tests/agent/cli-integration.test.ts
        env: {
          ...process.env,
          RUN_LIVE_LLM: '0', // force replay mode (override .env RUN_LIVE_LLM=1)
          REPLAY_FIXTURES_DIR: resolve('tests/fixtures/replay'),
          // v1.0.5.3 §1.3 — redirect USER.md reads so the repl test is
          // self-contained and doesn't read the dev's real profile or a
          // stale ./data/USER.md from a prior test run.
          APP_DATA_DIR: dataDir,
          ...env,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => {
      stdout += d.toString()
    })
    child.stderr.on('data', (d) => {
      stderr += d.toString()
    })
    child.on('error', rej)
    child.on('close', (code) => {
      // best-effort cleanup; Windows may EPERM if better-sqlite3 still mapped
      try { rmSync(dataDir, { recursive: true, force: true }) } catch { /* ignore */ }
      res({ exitCode: code, stdout, stderr })
    })

    // Write input with a small gap so the child has time to process each line
    // (readline needs to read, then the agent needs to stream back the response).
    setTimeout(() => {
      const lines = input.split('\n').filter((l) => l.length > 0)
      let i = 0
      const writeNext = () => {
        if (i >= lines.length) {
          setTimeout(() => child.stdin.end(), 200)
          return
        }
        child.stdin.write(`${lines[i]}\n`)
        i += 1
        setTimeout(writeNext, 600)
      }
      writeNext()
    }, 200)
  })
}

describe('CLI REPL (Replay mode)', () => {
  it('responds to "hi" with a greeting from the persona', async () => {
    const result = await runCli('hi\n', { API_KEY: 'sk-test' })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/English Oral Teacher Agent/)
    expect(result.stdout).toMatch(/Hi there/)
  }, 15000)

  it('replies twice in a 2-turn session', async () => {
    const result = await runCli('hi\nfine thanks\n', {
      API_KEY: 'sk-test',
    })
    expect(result.exitCode).toBe(0)
    const teacherCount = (result.stdout.match(/\[Teacher\]/g) ?? []).length
    expect(teacherCount).toBeGreaterThanOrEqual(2)
  }, 15000)
})
