import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import matter from 'gray-matter'
import lockfile from 'proper-lockfile'
import { getAppDataDir } from '../config/paths.js'

// v1.0.6 — when bundled with esbuild (--loader:.md=text), these imports
// become inline strings. The .default suffix handles esbuild's text export.
// In tsx (dev), these fail → we fall back to readFileSync.
let EMBEDDED_SOUL: string | null = null
let EMBEDDED_AGENTS: string | null = null
let EMBEDDED_TOOLS: string | null = null
let EMBEDDED_PHASES: string | null = null
let EMBEDDED_USER_EXAMPLE: string | null = null

try {
  EMBEDDED_SOUL = require('../../prompts/SOUL.md') as string
} catch { /* dev mode — fall back to readFileSync */ }
try {
  EMBEDDED_AGENTS = require('../../prompts/AGENTS.md') as string
} catch { /* dev mode */ }
try {
  EMBEDDED_TOOLS = require('../../prompts/tools.md') as string
} catch { /* dev mode */ }
try {
  EMBEDDED_PHASES = require('../../prompts/phases.md') as string
} catch { /* dev mode */ }
try {
  EMBEDDED_USER_EXAMPLE = require('../../prompts/USER.md.example') as string
} catch { /* dev mode */ }

export interface UserProfile {
  name: string
  age: number
  level: 'beginner' | 'intermediate' | 'advanced'
  goals: string[]
  interests: string[]
  voice_accent?: 'en-US' | 'en-GB'
  voice_speed?: number
}

export interface SystemPrompt {
  soul: string
  agents: string
  user: string
  userProfile: UserProfile
  tools: string | null
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const PROMPTS_DIR = existsSync(join(__dirname, 'prompts'))
  ? join(__dirname, 'prompts')
  : join(__dirname, '..', '..', 'prompts')
// v1.0.5.3 §1.3 — pkg-bundled example. After `pnpm build:copy-assets` runs,
// the .example file is copied to dist/prompts/USER.md.example. The dev
// path uses the source tree at <project>/prompts/USER.md.example. The
// fallback chain checks both locations so tests + dev + prod all work.
const EMBEDDED_EXAMPLE_PATHS = [
  join(PROMPTS_DIR, 'USER.md.example'),
]

let cachedExample: string | null = null

function loadEmbeddedExample(): string {
  if (cachedExample !== null) return cachedExample
  if (EMBEDDED_USER_EXAMPLE !== null) {
    cachedExample = EMBEDDED_USER_EXAMPLE
    return cachedExample
  }
  for (const p of EMBEDDED_EXAMPLE_PATHS) {
    if (existsSync(p)) {
      cachedExample = readFileSync(p, 'utf-8')
      return cachedExample
    }
  }
  throw new Error(
    `Could not find USER.md.example. Looked in: ${EMBEDDED_EXAMPLE_PATHS.join(', ')}. ` +
      `Run \`pnpm build:copy-assets\` to copy it from the source tree.`,
  )
}

function readIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf-8') : null
}

export interface LoadUserResult {
  body: string
  data: Record<string, unknown>
  seededFromExample: boolean
}

/**
 * v1.0.5.3 §1.3 — load the student profile from AppData. On first run
 * (no AppData/USER.md yet) we copy the embedded `USER.md.example` into
 * place so subsequent settings writes have a real file to update.
 *
 * Returns a `seededFromExample: true` flag the first time so callers can
 * show a "first-time setup complete" UI hint if they want.
 */
export function loadUserFile(): LoadUserResult {
  const userMdPath = join(getAppDataDir(), 'USER.md')

  if (existsSync(userMdPath)) {
    const raw = readFileSync(userMdPath, 'utf-8')
    const parsed = matter(raw)
    return { body: parsed.content, data: parsed.data, seededFromExample: false }
  }

  // First run: seed USER.md from the embedded example so subsequent
  // settings writes have a real file to update. Atomic write via tmp+rename.
  const exampleText = loadEmbeddedExample()
  seedUserMdFromExample(userMdPath, exampleText)
  const parsed = matter(exampleText)
  return { body: parsed.content, data: parsed.data, seededFromExample: true }
}

function seedUserMdFromExample(targetPath: string, exampleText: string): void {
  mkdirSync(getAppDataDir(), { recursive: true })
  const tmpPath = `${targetPath}.tmp.${Date.now()}`
  writeFileSync(tmpPath, exampleText, 'utf-8')
  // Atomic rename (NTFS supports rename-over-existing)
  renameSync(tmpPath, targetPath)
}

const REQUIRED_USER_FIELDS = ['name', 'age', 'level', 'goals', 'interests'] as const

function parseUserProfile(data: Record<string, unknown>): UserProfile {
  for (const field of REQUIRED_USER_FIELDS) {
    if (!(field in data)) {
      throw new Error(`USER.md frontmatter is missing required field: "${field}"`)
    }
  }

  const level = data.level
  if (level !== 'beginner' && level !== 'intermediate' && level !== 'advanced') {
    throw new Error(
      `USER.md frontmatter "level" must be beginner|intermediate|advanced, got: ${String(level)}`,
    )
  }

  return {
    name: String(data.name),
    age: Number(data.age),
    level,
    goals: Array.isArray(data.goals) ? data.goals.map(String) : [],
    interests: Array.isArray(data.interests) ? data.interests.map(String) : [],
    voice_accent:
      data.voice_accent === 'en-US' || data.voice_accent === 'en-GB'
        ? data.voice_accent
        : undefined,
    voice_speed: typeof data.voice_speed === 'number' ? data.voice_speed : undefined,
  }
}

// v1.0.4 §3.4 — runtime guard: each source file must start with a '# Title'
// heading after trim. This catches the case where a hand-maintained prompt
// file silently loses its H1 and produces a malformed system prompt.
//
// Exported for testing (the failure-mode test would otherwise need real
// file IO mocking — exporting lets us test the regex/throwing logic
// directly against crafted strings).
export function assertHasH1(label: string, body: string): void {
  const firstLine = body.trim().split('\n', 1)[0]?.trim() ?? ''
  if (!/^# \S/.test(firstLine)) {
    throw new Error(
      `[loader] ${label} must start with a '# <Title>' heading after trim. Got: ${JSON.stringify(firstLine.slice(0, 40))}. See v1.0.4-design.md §3.4.`,
    )
  }
}

export function loadSystemPrompt(): SystemPrompt {
  const soul = EMBEDDED_SOUL ?? readIfExists(join(PROMPTS_DIR, 'SOUL.md'))
  const agents = EMBEDDED_AGENTS ?? readIfExists(join(PROMPTS_DIR, 'AGENTS.md'))
  const tools = EMBEDDED_TOOLS ?? readIfExists(join(PROMPTS_DIR, 'tools.md'))

  if (!soul) {
    throw new Error(`Missing prompts/SOUL.md (looked in ${PROMPTS_DIR})`)
  }
  if (!agents) {
    throw new Error(`Missing prompts/AGENTS.md (looked in ${PROMPTS_DIR})`)
  }

  const { body: userBody, data: userData } = loadUserFile()
  const userProfile = parseUserProfile(userData)

  // v1.0.4 §1.1 — every section's H1 must come from the source file itself,
  // not the loader. `assertHasH1` fails fast if a hand-maintained file loses
  // its heading. USER.md is required to begin with `# STUDENT` (see
  // prompts/USER.md) so its body passes the check.
  assertHasH1('prompts/SOUL.md', soul)
  assertHasH1('prompts/AGENTS.md', agents)
  assertHasH1('prompts/USER.md', userBody)
  // tools.md is optional; only check when present.
  if (tools) assertHasH1('prompts/tools.md', tools)

  return {
    soul,
    agents,
    user: userBody.trim(),
    userProfile,
    tools: tools ? tools.trim() : null,
  }
}

export function buildSystemString(sp: SystemPrompt): string {
  // v1.0.4 §1.1 — H1s are owned by the source files themselves (SOUL.md,
  // AGENTS.md, USER.md, tools.md). The loader no longer prepends any heading;
  // it just concatenates the trimmed bodies with blank-line separators.
  const sections = [sp.soul.trim(), '', sp.agents.trim(), '', sp.user]
  if (sp.tools) {
    sections.push('', sp.tools)
  }
  return sections.join('\n')
}

// v0.8.5 — load phase instructions from editable prompts/phases.md.
export interface PhaseInstructions {
  context: Record<string, string>
  reminder: Record<string, string>
}

export function loadPhaseInstructions(): PhaseInstructions {
  const raw = EMBEDDED_PHASES ?? readIfExists(join(PROMPTS_DIR, 'phases.md'))
  if (!raw) throw new Error(`Missing prompts/phases.md (looked in ${PROMPTS_DIR})`)

  const context: Record<string, string> = {}
  const reminder: Record<string, string> = {}

  // Normalize line endings, then split on phase headers.
  const text = raw.replace(/\r\n/g, '\n')
  const phases = text.split(/\n(?=# (?:WARM_UP|MAIN_ACTIVITY|WRAP_UP|END)\b)/)
  for (const block of phases) {
    const headerMatch = block.match(/^# (WARM_UP|MAIN_ACTIVITY|WRAP_UP|END)\s*$/m)
    const phase = headerMatch?.[1]
    if (!phase) continue

    const contextMatch = /## Context[^\n]*\n([\s\S]*?)(?=\n## Reminder|$)/.exec(block)
    if (contextMatch?.[1]) {
      context[phase] = contextMatch[1].trim()
    }

    const reminderMatch = /## Reminder[^\n]*\n([\s\S]*)$/.exec(block)
    if (reminderMatch?.[1]) {
      reminder[phase] = reminderMatch[1].trim()
    }
  }

  if (Object.keys(context).length === 0) {
    throw new Error('phases.md: no phase entries found')
  }
  return { context, reminder }
}

// v1.0.5.3 §1.3 — atomic USER.md write for settings persistence.
// Uses proper-lockfile to prevent races between server and CLI processes.
// USER.md lives in AppData (not PROMPTS_DIR) so pkg snapshot + per-instance
// isolation both work. The seed path reuses loadUserFile() which already
// auto-seeds from the build-time-embedded example.
export async function updateUserSettings(
  updates: Partial<{
    voice_enabled: boolean
    voice_speed: number
    voice_accent: string
    interests: string[]
    bodyAppend: string
    // v1.0.5.4 §6.5 — /setup wizard writes core profile fields directly.
    name: string
    age: number
    level: 'beginner' | 'intermediate' | 'advanced'
    goals: string[]
  }>,
): Promise<void> {
  const path = join(getAppDataDir(), 'USER.md')

  // proper-lockfile requires the file to exist before locking. If USER.md
  // doesn't exist yet, trigger the loadUserFile() seed path first.
  if (!existsSync(path)) {
    loadUserFile()
  }

  const release = await lockfile.lock(path, { retries: 3 })
  try {
    const raw = await readFile(path, 'utf8')
    const { data, content } = matter(raw)

    // Merge top-level fields
    const newData: Record<string, unknown> = { ...data }
    if (updates.voice_enabled !== undefined) newData.voice_enabled = updates.voice_enabled
    if (updates.voice_speed !== undefined) newData.voice_speed = updates.voice_speed
    if (updates.voice_accent !== undefined) newData.voice_accent = updates.voice_accent
    if (updates.name !== undefined) newData.name = updates.name
    if (updates.age !== undefined) newData.age = updates.age
    if (updates.level !== undefined) newData.level = updates.level

    // Merge interests: append new ones, deduplicate
    if (updates.interests && updates.interests.length > 0) {
      const existing = Array.isArray(data.interests) ? data.interests : []
      newData.interests = [...new Set([...existing, ...updates.interests])]
    }

    // Goals are a full replacement (not a merge) — the wizard edits the
    // whole list at once, and partial merges would leave stale goals behind.
    if (updates.goals !== undefined) {
      newData.goals = [...updates.goals]
    }

    // Append body update
    let newContent = content
    if (updates.bodyAppend) {
      const trimmed = content.trim()
      newContent = trimmed ? `${trimmed}\n\n${updates.bodyAppend.trim()}` : updates.bodyAppend.trim()
    }

    const newRaw = matter.stringify(newContent, newData)
    const tmpPath = `${path}.tmp.${Date.now()}`
    await writeFile(tmpPath, newRaw, 'utf8')
    await rename(tmpPath, path)
  } finally {
    await release()
  }
}
