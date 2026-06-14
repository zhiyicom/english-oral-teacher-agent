import { existsSync, readFileSync } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import matter from 'gray-matter'
import lockfile from 'proper-lockfile'

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
  topicLibrary: string | null
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const PROMPTS_DIR = join(__dirname, '..', '..', 'prompts')

function readIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf-8') : null
}

export function loadUserFile(): { body: string; data: Record<string, unknown> } {
  const real = join(PROMPTS_DIR, 'USER.md')
  const example = join(PROMPTS_DIR, 'USER.md.example')

  if (existsSync(real)) {
    const raw = readFileSync(real, 'utf-8')
    const parsed = matter(raw)
    return { body: parsed.content, data: parsed.data }
  }

  if (existsSync(example)) {
    const raw = readFileSync(example, 'utf-8')
    const parsed = matter(raw)
    return { body: parsed.content, data: parsed.data }
  }

  throw new Error(
    `No USER.md or USER.md.example found in ${PROMPTS_DIR}. Create one (see prompts/USER.md.example) before running the agent.`,
  )
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

export function loadSystemPrompt(): SystemPrompt {
  const soul = readIfExists(join(PROMPTS_DIR, 'SOUL.md'))
  const agents = readIfExists(join(PROMPTS_DIR, 'AGENTS.md'))
  const tools = readIfExists(join(PROMPTS_DIR, 'tools.md'))
  const topicLibrary = readIfExists(join(PROMPTS_DIR, 'topic-library.md'))

  if (!soul) {
    throw new Error(`Missing prompts/SOUL.md (looked in ${PROMPTS_DIR})`)
  }
  if (!agents) {
    throw new Error(`Missing prompts/AGENTS.md (looked in ${PROMPTS_DIR})`)
  }

  const { body: userBody, data: userData } = loadUserFile()
  const userProfile = parseUserProfile(userData)

  return {
    soul,
    agents,
    user: userBody.trim(),
    userProfile,
    tools: tools ? tools.trim() : null,
    topicLibrary: topicLibrary ? topicLibrary.trim() : null,
  }
}

export function buildSystemString(sp: SystemPrompt): string {
  const sections = [
    '# SOUL',
    '',
    sp.soul.trim(),
    '',
    '# AGENTS',
    '',
    sp.agents.trim(),
    '',
    '# STUDENT',
    '',
    sp.user,
  ]
  if (sp.tools) {
    sections.push('', '# TOOLS', '', sp.tools)
  }
  if (sp.topicLibrary) {
    sections.push('', '# TOPIC_LIBRARY', '', sp.topicLibrary)
  }
  return sections.join('\n')
}

// v0.8.4 — atomic USER.md write for settings persistence.
// Uses proper-lockfile to prevent races between server and CLI processes.
export async function updateUserSettings(
  updates: Partial<{ voice_enabled: boolean; voice_speed: number; voice_accent: string }>,
): Promise<void> {
  const path = join(PROMPTS_DIR, 'USER.md')
  const example = join(PROMPTS_DIR, 'USER.md.example')

  // proper-lockfile requires the file to exist before locking.
  // If USER.md doesn't exist yet, seed it from .example first.
  try {
    await readFile(path, 'utf8')
  } catch {
    if (existsSync(example)) {
      const exampleRaw = await readFile(example, 'utf8')
      await writeFile(path, exampleRaw, 'utf8')
    }
  }

  const release = await lockfile.lock(path, { retries: 3 })
  try {
    const raw = await readFile(path, 'utf8')
    const { data, content } = matter(raw)
    const newData = { ...data, ...updates }
    const newRaw = matter.stringify(content, newData)
    const tmpPath = `${path}.tmp.${Date.now()}`
    await writeFile(tmpPath, newRaw, 'utf8')
    await rename(tmpPath, path)
  } finally {
    await release()
  }
}
