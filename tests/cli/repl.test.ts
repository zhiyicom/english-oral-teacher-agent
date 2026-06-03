import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const CLI_PATH = resolve('src/cli.ts')

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
    child.stdout.on('data', (d) => {
      stdout += d.toString()
    })
    child.stderr.on('data', (d) => {
      stderr += d.toString()
    })
    child.on('error', rej)
    child.on('close', (code) => res({ exitCode: code, stdout, stderr }))

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
    const result = await runCli('hi\n', { MINIMAX_API_KEY: 'sk-test' })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/English Oral Teacher Agent/)
    expect(result.stdout).toMatch(/Hi there/)
  }, 15000)

  it('replies twice in a 2-turn session', async () => {
    const result = await runCli('hi\nfine thanks\n', {
      MINIMAX_API_KEY: 'sk-test',
    })
    expect(result.exitCode).toBe(0)
    const teacherCount = (result.stdout.match(/\[Teacher\]/g) ?? []).length
    expect(teacherCount).toBeGreaterThanOrEqual(2)
  }, 15000)
})
