import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import matter from 'gray-matter'

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
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const PROMPTS_DIR = join(__dirname, '..', '..', 'prompts')

function readIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf-8') : null
}

function loadUserFile(): { body: string; data: Record<string, unknown> } {
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
  }
}

export function buildSystemString(sp: SystemPrompt): string {
  return [
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
  ].join('\n')
}
