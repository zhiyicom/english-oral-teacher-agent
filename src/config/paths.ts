import { existsSync, mkdirSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * v1.0.5.2 §1.2 — resolve the per-user data directory with priority:
 *   1. APP_DATA_DIR env var (explicit override; absolute or CWD-relative)
 *   2. ./data if it already contains a sessions DB (legacy back-compat)
 *   3. Platform default:
 *      - Windows: %APPDATA%\EnglishOralTeacher\
 *      - macOS:   ~/Library/Application Support/english-oral-teacher/
 *      - Linux:   ${XDG_CONFIG_HOME:-~/.config}/english-oral-teacher/
 *
 * Creates the directory (recursively) on first call. Returns an absolute path.
 *
 * Used by CLI, server, and prompts/loader.ts so all writes land in the
 * same place. The installer (v1.0.6) sets APP_DATA_DIR explicitly; portable
 * dev runs leave it unset and get the platform fallback.
 */
export function getAppDataDir(): string {
  const explicit = process.env.APP_DATA_DIR?.trim()
  if (explicit) {
    const resolved = resolve(explicit)
    ensureDir(resolved)
    return resolved
  }

  const legacyPath = resolve('./data')
  const legacyDb = join(legacyPath, 'oral-teacher.db')
  if (existsSync(legacyDb)) {
    process.stderr.write(
      `[startup] WARN: legacy data found at ${legacyPath}. ` +
        `Set APP_DATA_DIR=./data in .env to keep using it, ` +
        `or move ./data/* to the platform default location.\n`,
    )
    ensureDir(legacyPath)
    return legacyPath
  }

  const platformDefault = platformAppDataDir()
  ensureDir(platformDefault)
  return platformDefault
}

/**
 * v1.0.5.2 §1.2 — subdirectory under the app data dir. Used for
 *   - data/llm-debug/ (debug logs)
 *   - data/replay/   (replay fixtures when not in dev mode)
 *   - data/USER.md   (student profile — see §1.3)
 */
export function getSubDir(name: string): string {
  const base = getAppDataDir()
  const sub = join(base, name)
  ensureDir(sub)
  return sub
}

/**
 * v1.0.5.2 §1.2 §4.5 — replay fixtures directory. Explicit
 * REPLAY_FIXTURES_DIR wins (used by L3 tests to point at
 * tests/fixtures/replay without polluting AppData). Falls back to
 * {APP_DATA_DIR}/replay/ in production.
 */
export function getReplayFixturesDir(): string {
  const explicit = process.env.REPLAY_FIXTURES_DIR?.trim()
  if (explicit) return resolve(explicit)
  return getSubDir('replay')
}

function platformAppDataDir(): string {
  const name = platform() === 'win32' ? 'EnglishOralTeacher' : 'english-oral-teacher'
  switch (platform()) {
    case 'win32':
      return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), name)
    case 'darwin':
      return join(homedir(), 'Library', 'Application Support', name)
    default: {
      const xdg = process.env.XDG_CONFIG_HOME?.trim()
      const base = xdg && xdg.length > 0 ? xdg : join(homedir(), '.config')
      return join(base, name)
    }
  }
}

function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true })
}
