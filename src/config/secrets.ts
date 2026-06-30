import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { getAppDataDir } from './paths.js'

/**
 * v1.0.6 §1.6 — API key resolution priority chain:
 *   1. process.env.API_KEY (test + dev injection)
 *   2. {APP_DATA_DIR}/.env (wizard writes here)
 *   3. <cwd>/.env (legacy dev fallback)
 *
 * Returns null when no source has a non-empty value.
 */
export function getApiKey(): string | null {
  const fromEnv = process.env.API_KEY?.trim()
  if (fromEnv) return fromEnv

  const fromAppData = readEnvFile(join(getAppDataDir(), '.env')).API_KEY
  if (fromAppData?.trim()) return fromAppData.trim()

  const fromCwd = readEnvFile(join(process.cwd(), '.env')).API_KEY
  if (fromCwd?.trim()) return fromCwd.trim()

  return null
}

export function isSetupNeeded(): boolean {
  return getApiKey() === null
}

export function setApiKey(key: string): { persisted: string[] } {
  if (!key.trim()) throw new Error('API key cannot be empty')
  const envPath = join(getAppDataDir(), '.env')

  let current: Record<string, string> = {}
  if (existsSync(envPath)) current = readEnvFile(envPath)

  const persisted: string[] = []
  if (current.API_KEY !== key) {
    current.API_KEY = key
    persisted.push('API_KEY')
  }

  const content =
    Object.entries(current)
      .map(([k, v]) => {
        const needsQuote = /\s|["'=#]/.test(v)
        return needsQuote ? `${k}="${v.replace(/"/g, '\\"')}"` : `${k}=${v}`
      })
      .join('\n') + '\n'

  const tmp = `${envPath}.tmp.${Date.now()}`
  writeFileSync(tmp, content, 'utf-8')
  renameSync(tmp, envPath)
  process.env.API_KEY = key
  return { persisted }
}

function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {}
  const content = readFileSync(path, 'utf-8')
  const result: Record<string, string> = {}
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const m = trimmed.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (m && m[2] !== undefined) {
      const val = m[2].replace(/^["']|["']$/g, '')
      result[m[1]!] = val
    }
  }
  return result
}
