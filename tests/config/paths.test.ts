import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// v1.0.5.2 §1.2 — getAppDataDir() priority chain:
//   1. APP_DATA_DIR env var (explicit override)
//   2. ./data if oral-teacher.db exists (legacy back-compat + warning)
//   3. Platform default (Windows APPDATA / macOS ~/Library/... / Linux XDG_CONFIG_HOME)
//
// We use vi.resetModules() + dynamic import to re-evaluate paths.ts
// after each env-var change, so module-scoped caching doesn't poison
// tests. We mock `os.platform()` per-test to cover the 3 platform
// fallbacks.

const realEnv = { ...process.env }

function clearEnvVars(): void {
  delete process.env.APP_DATA_DIR
  delete process.env.REPLAY_FIXTURES_DIR
  delete process.env.APPDATA
  delete process.env.XDG_CONFIG_HOME
  delete process.env.HOME
}

async function loadFresh(): Promise<typeof import('../../src/config/paths.js')> {
  vi.resetModules()
  return import('../../src/config/paths.js')
}

describe('getAppDataDir (v1.0.5.2 §1.2)', () => {
  let scratch: string

  beforeEach(() => {
    clearEnvVars()
    scratch = mkdtempSync(join(tmpdir(), 'paths-test-'))
  })

  afterEach(() => {
    clearEnvVars()
    process.env = { ...realEnv }
    vi.restoreAllMocks()
  })

  it('priority 1: APP_DATA_DIR explicit override wins (absolute path)', async () => {
    const { getAppDataDir } = await loadFresh()
    const target = join(scratch, 'my-appdata')
    process.env.APP_DATA_DIR = target
    expect(getAppDataDir()).toBe(resolve(target))
    expect(existsSync(target)).toBe(true)
  })

  it('priority 1: APP_DATA_DIR explicit override creates the dir if missing', async () => {
    const { getAppDataDir } = await loadFresh()
    const target = join(scratch, 'new-dir')
    process.env.APP_DATA_DIR = target
    expect(existsSync(target)).toBe(false)
    getAppDataDir()
    expect(existsSync(target)).toBe(true)
  })

  it('priority 2: legacy ./data/oral-teacher.db triggers legacy + warning', async () => {
    // Save CWD and chdir into scratch
    const cwd = process.cwd()
    process.chdir(scratch)
    const legacyDir = join(scratch, 'data')
    mkdirSafe(legacyDir)
    writeFileSync(join(legacyDir, 'oral-teacher.db'), '')
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const { getAppDataDir } = await loadFresh()
      const result = getAppDataDir()
      expect(result).toBe(resolve(legacyDir))
      const warns = stderrSpy.mock.calls.map((c) => String(c[0])).join('')
      expect(warns).toContain('legacy data found')
    } finally {
      stderrSpy.mockRestore()
      rmSafe(legacyDir)
      process.chdir(cwd)
    }
  })

  it('priority 3: Windows fallback uses %APPDATA%', async () => {
    // chdir to scratch so the project's own ./data/oral-teacher.db
    // doesn't trigger priority-2 (legacy) and skip the platform test.
    const cwd = process.cwd()
    process.chdir(scratch)
    vi.doMock('node:os', async (importActual) => {
      const actual = await importActual<typeof import('node:os')>()
      return { ...actual, platform: () => 'win32' as NodeJS.Platform }
    })
    process.env.APPDATA = join(scratch, 'AppData', 'Roaming')
    const { getAppDataDir } = await loadFresh()
    const result = getAppDataDir()
    expect(result).toBe(join(process.env.APPDATA, 'EnglishOralTeacher'))
    expect(existsSync(result)).toBe(true)
    process.chdir(cwd)
  })

  it('priority 3: macOS fallback uses ~/Library/Application Support/', async () => {
    const cwd = process.cwd()
    process.chdir(scratch)
    vi.doMock('node:os', async (importActual) => {
      const actual = await importActual<typeof import('node:os')>()
      return { ...actual, platform: () => 'darwin' as NodeJS.Platform, homedir: () => scratch }
    })
    const { getAppDataDir } = await loadFresh()
    const result = getAppDataDir()
    expect(result).toBe(join(scratch, 'Library', 'Application Support', 'english-oral-teacher'))
    expect(existsSync(result)).toBe(true)
    process.chdir(cwd)
  })

  it('priority 3: Linux fallback uses XDG_CONFIG_HOME when set', async () => {
    const cwd = process.cwd()
    process.chdir(scratch)
    vi.doMock('node:os', async (importActual) => {
      const actual = await importActual<typeof import('node:os')>()
      return { ...actual, platform: () => 'linux' as NodeJS.Platform, homedir: () => scratch }
    })
    process.env.XDG_CONFIG_HOME = join(scratch, 'xdg')
    const { getAppDataDir } = await loadFresh()
    const result = getAppDataDir()
    expect(result).toBe(join(scratch, 'xdg', 'english-oral-teacher'))
    process.chdir(cwd)
  })

  it('priority 3: Linux fallback uses ~/.config when XDG_CONFIG_HOME is unset', async () => {
    const cwd = process.cwd()
    process.chdir(scratch)
    vi.doMock('node:os', async (importActual) => {
      const actual = await importActual<typeof import('node:os')>()
      return { ...actual, platform: () => 'linux' as NodeJS.Platform, homedir: () => scratch }
    })
    const { getAppDataDir } = await loadFresh()
    const result = getAppDataDir()
    expect(result).toBe(join(scratch, '.config', 'english-oral-teacher'))
    process.chdir(cwd)
  })

  it('first call creates the directory recursively', async () => {
    const { getAppDataDir } = await loadFresh()
    process.env.APP_DATA_DIR = join(scratch, 'a', 'b', 'c')
    expect(existsSync(process.env.APP_DATA_DIR)).toBe(false)
    getAppDataDir()
    expect(existsSync(process.env.APP_DATA_DIR)).toBe(true)
  })
})

describe('getSubDir (v1.0.5.2 §1.2)', () => {
  let scratch: string
  beforeEach(() => {
    clearEnvVars()
    scratch = mkdtempSync(join(tmpdir(), 'paths-sub-'))
  })
  afterEach(() => {
    clearEnvVars()
    process.env = { ...realEnv }
    vi.restoreAllMocks()
  })

  it('creates a subdirectory under the app data dir', async () => {
    process.env.APP_DATA_DIR = join(scratch, 'root')
    const { getAppDataDir, getSubDir } = await loadFresh()
    const sub = getSubDir('replay')
    expect(sub).toBe(join(scratch, 'root', 'replay'))
    expect(existsSync(sub)).toBe(true)
    expect(getAppDataDir()).toBe(join(scratch, 'root'))
  })
})

describe('getReplayFixturesDir (v1.0.5.2 §1.2 §4.5)', () => {
  let scratch: string
  beforeEach(() => {
    clearEnvVars()
    scratch = mkdtempSync(join(tmpdir(), 'paths-replay-'))
  })
  afterEach(() => {
    clearEnvVars()
    process.env = { ...realEnv }
    vi.restoreAllMocks()
  })

  it('REPLAY_FIXTURES_DIR explicit wins (absolute path)', async () => {
    const { getReplayFixturesDir } = await loadFresh()
    const target = join(scratch, 'my-fixtures')
    process.env.REPLAY_FIXTURES_DIR = target
    expect(getReplayFixturesDir()).toBe(resolve(target))
  })

  it('no REPLAY_FIXTURES_DIR: falls back to {APP_DATA_DIR}/replay/', async () => {
    process.env.APP_DATA_DIR = join(scratch, 'appdata')
    const { getReplayFixturesDir } = await loadFresh()
    const sub = getReplayFixturesDir()
    expect(sub).toBe(join(scratch, 'appdata', 'replay'))
    expect(existsSync(sub)).toBe(true)
  })
})

// helpers
import { mkdirSync, rmSync } from 'node:fs'

function mkdirSafe(p: string): void {
  if (!existsSync(p)) mkdirSync(p, { recursive: true })
}
function rmSafe(p: string): void {
  try {
    rmSync(p, { recursive: true, force: true })
  } catch {
    // best-effort
  }
}
