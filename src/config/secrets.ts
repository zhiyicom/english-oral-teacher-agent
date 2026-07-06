import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { getAppDataDir } from './paths.js'

// Header block — always prepended to the .env file. Comment-only (no key=value
// lines) so readEnvFile / formatEnvFile roundtrips are clean with no duplication.
const ENV_HEADER = [
  '# English Oral Teacher — 环境配置',
  '# 修改此文件后重启应用生效',
  '#',
  '# === 调试日志 ===',
  '# DEBUG_LOG_LLM — 开启 LLM 详细诊断日志',
  '#   启用: 1  禁用: 0 或留空（默认禁用）',
  '#   日志写入 data/llm-debug/ 目录（每轮 prompt、summary 失败原因等）',
  '#',
  '# APP_LOG_LEVEL — 应用日志级别',
  '#   可选: debug | info | warn | error（默认 info）',
  '#   debug 会输出所有调试信息（含每轮对话详情）',
  '',
].join('\n') + '\n'

// Defaults for documented config keys. Inserted into the body on first write
// so the user sees both the explanatory comments (header) and the active value.
const ENV_DEFAULTS: Record<string, string> = {
  DEBUG_LOG_LLM: '0',
  APP_LOG_LEVEL: 'info',
}

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

  const current = readEnvFile(envPath)
  const persisted: string[] = []
  if (current.API_KEY !== key) {
    current.API_KEY = key
    persisted.push('API_KEY')
  }

  const content = formatEnvFile(current)
  const tmp = `${envPath}.tmp.${Date.now()}`
  mkdirSync(join(envPath, '..'), { recursive: true })
  writeFileSync(tmp, content, 'utf-8')
  renameSync(tmp, envPath)
  process.env.API_KEY = key
  return { persisted }
}

export function setEnvVar(key: string, value: string): { persisted: string[] } {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) throw new Error(`Invalid env key: ${key}`)
  const envPath = join(getAppDataDir(), '.env')

  const current = readEnvFile(envPath)
  const persisted: string[] = []
  if (current[key] !== value) {
    current[key] = value
    persisted.push(key)
  }

  const content = formatEnvFile(current)
  const tmp = `${envPath}.tmp.${Date.now()}`
  mkdirSync(join(envPath, '..'), { recursive: true })
  writeFileSync(tmp, content, 'utf-8')
  renameSync(tmp, envPath)
  process.env[key] = value
  return { persisted }
}

function formatEnvFile(vars: Record<string, string>): string {
  // Merge defaults so documented keys always appear with an active value
  const merged = { ...ENV_DEFAULTS, ...vars }
  const body = Object.entries(merged)
    .map(([k, v]) => {
      const needsQuote = /\s|["'=#]/.test(v)
      return needsQuote ? `${k}="${v.replace(/"/g, '\\"')}"` : `${k}=${v}`
    })
    .join('\n') + '\n'
  return ENV_HEADER + body
}

export function getEnvVar(key: string): string {
  const fromEnv = process.env[key]
  if (fromEnv !== undefined) return fromEnv

  const fromAppData = readEnvFile(join(getAppDataDir(), '.env'))[key]
  if (fromAppData !== undefined) return fromAppData

  const fromCwd = readEnvFile(join(process.cwd(), '.env'))[key]
  return fromCwd ?? ''
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
