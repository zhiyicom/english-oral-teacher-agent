import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { logSummarizeFailure } from '../../src/llm/debug-log.js'

// v1.0.6 hotfix — logSummarizeFailure() must write a structured record to
// data/llm-debug/ whenever summarize() throws, so the next silent failure
// is diagnosable without depending on the stderr stream being captured.
//
// The function is NOT gated on DEBUG_LOG_LLM=1 (the whole point is to catch
// failures when the user forgot to enable the env var). These tests cover:
//   1. file is created in the right directory with the right name pattern
//   2. file contains the key error fields (name, message, stack, status)
//   3. works even when DEBUG_LOG_LLM=1 is not set
//   4. works for an unknown error shape (string, plain object, etc.)
//   5. does not throw when the data dir is unwritable (best-effort)

let originalCwd: string
let tempDir: string

beforeEach(() => {
  originalCwd = process.cwd()
  tempDir = mkdtempSync(join(tmpdir(), 'debug-log-test-'))
  process.chdir(tempDir)
  // Ensure DEBUG_LOG_LLM is NOT set so we exercise the always-on path.
  delete process.env.DEBUG_LOG_LLM
})

afterEach(() => {
  process.chdir(originalCwd)
  try {
    rmSync(tempDir, { recursive: true, force: true })
  } catch {
    // best-effort cleanup
  }
})

describe('logSummarizeFailure', () => {
  it('writes a record to data/llm-debug/ even when DEBUG_LOG_LLM is unset', () => {
    expect(process.env.DEBUG_LOG_LLM).toBeUndefined()

    const err = new Error('boom')
    logSummarizeFailure('aaaaaaaa-1111-2222-3333-444444444444', 42, 'user_stop', err)

    const debugDir = join(tempDir, 'data', 'llm-debug')
    expect(existsSync(debugDir)).toBe(true)
    const files = readdirSync(debugDir)
    expect(files.length).toBe(1)
    // Filename pattern: {ISO timestamp with :-.} -> -}_{sessionShort}_summarize-failed.txt
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_aaaaaaaa_summarize-failed\.txt$/)
  })

  it('captures standard Error fields (name, message, stack)', () => {
    const err = new TypeError('Connection reset by peer')
    logSummarizeFailure('bbbbbbbb-1111-2222-3333-444444444444', 17, 'user_stop', err)

    const debugDir = join(tempDir, 'data', 'llm-debug')
    const files = readdirSync(debugDir)
    const content = readFileSync(join(debugDir, files[0]!), 'utf-8')

    expect(content).toContain('=== Summarize Failure ===')
    expect(content).toContain('Session: bbbbbbbb-1111-2222-3333-444444444444')
    expect(content).toContain('Messages: 17')
    expect(content).toContain('Ended reason: user_stop')
    expect(content).toContain('Error name: TypeError')
    expect(content).toContain('Error message: Connection reset by peer')
    expect(content).toContain('Error stack:')
    // The stack should include "TypeError:" so we can see the runtime trace
    expect(content).toMatch(/TypeError: Connection reset by peer/)
  })

  it('captures Anthropic SDK-style error fields (status, cause)', () => {
    // Mimic an SDK error shape: name + message + status + cause
    const cause = new Error('ETIMEDOUT')
    const err = Object.assign(new Error('Request timed out'), {
      name: 'APIConnectionError',
      status: 500,
      cause,
    })

    logSummarizeFailure('cccccccc-1111-2222-3333-444444444444', 99, 'phase_end', err)

    const debugDir = join(tempDir, 'data', 'llm-debug')
    const files = readdirSync(debugDir)
    const content = readFileSync(join(debugDir, files[0]!), 'utf-8')

    expect(content).toContain('Error name: APIConnectionError')
    expect(content).toContain('Error message: Request timed out')
    expect(content).toContain('Error status: 500')
  })

  it('handles an unknown error shape (plain string) without throwing', () => {
    expect(() => {
      logSummarizeFailure('dddddddd-1111-2222-3333-444444444444', 5, 'user_stop', 'just a string')
    }).not.toThrow()

    const debugDir = join(tempDir, 'data', 'llm-debug')
    const files = readdirSync(debugDir)
    const content = readFileSync(join(debugDir, files[0]!), 'utf-8')
    // Unknown shape: name/message/status default to '(none)'
    expect(content).toContain('Error name: (none)')
    expect(content).toContain('Error message: (none)')
  })

  it('handles endedReason=null gracefully', () => {
    const err = new Error('x')
    logSummarizeFailure('eeeeeeee-1111-2222-3333-444444444444', 3, null, err)

    const debugDir = join(tempDir, 'data', 'llm-debug')
    const files = readdirSync(debugDir)
    const content = readFileSync(join(debugDir, files[0]!), 'utf-8')
    expect(content).toContain('Ended reason: (unknown)')
  })
})
