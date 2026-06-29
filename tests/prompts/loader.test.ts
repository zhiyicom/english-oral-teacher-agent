import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import matter from 'gray-matter'
import {
  assertHasH1,
  buildSystemString,
  loadSystemPrompt,
  loadUserFile,
  updateUserSettings,
} from '../../src/prompts/loader.js'

// v1.0.5.3 §1.3 — redirect USER.md to a temp dir so the seed/load/update
// tests don't touch the dev install's profile. Per-describe beforeEach
// rewrites a known starting state (seeded example) so the order of
// describe blocks does not matter for downstream tests.
const SCRATCH = join(tmpdir(), `loader-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
const savedAppData = process.env.APP_DATA_DIR
process.env.APP_DATA_DIR = SCRATCH

afterAll(() => {
  if (savedAppData === undefined) {
    delete process.env.APP_DATA_DIR
  } else {
    process.env.APP_DATA_DIR = savedAppData
  }
  try {
    rmSync(SCRATCH, { recursive: true, force: true })
  } catch {
    // best-effort
  }
})

/** Reset SCRATCH to a clean state and seed USER.md from the embedded example. */
function resetToSeeded(): void {
  rmSync(SCRATCH, { recursive: true, force: true })
  mkdirSync(SCRATCH, { recursive: true })
  // Use the same import path the loader uses (so we test what the loader
  // actually embeds). The `?raw` import is resolved at build time.
  // We re-implement the seed here in a deliberately self-contained way.
  const seedRaw = readFileSync(join(__dirname, '..', '..', 'prompts', 'USER.md.example'), 'utf-8')
  writeFileSync(join(SCRATCH, 'USER.md'), seedRaw, 'utf-8')
}

describe('loadSystemPrompt', () => {
  beforeEach(resetToSeeded)

  it('returns non-empty soul, agents, user, and parsed profile', () => {
    const sp = loadSystemPrompt()
    expect(sp.soul.length).toBeGreaterThan(20)
    expect(sp.agents.length).toBeGreaterThan(20)
    expect(sp.user.length).toBeGreaterThan(0)
    expect(sp.userProfile.name).toBeTruthy()
    expect(typeof sp.userProfile.age).toBe('number')
    expect(['beginner', 'intermediate', 'advanced']).toContain(sp.userProfile.level)
  })

  it('loads prompts/tools.md when present (v0.7)', () => {
    const sp = loadSystemPrompt()
    expect(sp.tools).not.toBeNull()
    expect(sp.tools).toContain('mark_mistake')
    expect(sp.tools).toMatch(/<tool>/)
  })

  it('passes H1 runtime guard when all 4 source files have H1 (v1.0.4 §3.4)', () => {
    // Sanity: real prompts files all start with their H1 → loadSystemPrompt
    // returns successfully.
    expect(() => loadSystemPrompt()).not.toThrow()
  })
})

describe('buildSystemString (v1.0.4 §1.1 — H1 single-source)', () => {
  beforeEach(resetToSeeded)

  it('concatenates sections with each H1 appearing exactly once', () => {
    // v1.0.4 §1.1 — H1 ownership is now entirely on the source files
    // (SOUL.md / AGENTS.md / USER.md / tools.md). Loader no longer prepends
    // any '# <Title>' — it just joins the trimmed bodies. Each H1 must show
    // up exactly once in the rendered output.
    const sp = loadSystemPrompt()
    const s = buildSystemString(sp)

    const count = (re: RegExp) => (s.match(re) ?? []).length

    // SOUL.md has '# SOUL' → exactly 1 occurrence
    expect(count(/^# SOUL$/m)).toBe(1)
    // AGENTS.md has '# AGENTS — operating manual' → exactly 1
    expect(count(/^# AGENTS — operating manual$/m)).toBe(1)
    // USER.md body starts with '# STUDENT' (added in v1.0.4) → exactly 1
    expect(count(/^# STUDENT$/m)).toBe(1)
    // tools.md has '# Tool Calling' → exactly 1
    expect(count(/^# Tool Calling$/m)).toBe(1)
    // Pre-v1.0.4 loader also emitted a bare '# TOOLS' H1 — must NOT appear
    expect(count(/^# TOOLS$/m)).toBe(0)
    expect(count(/^# AGENTS$/m)).toBe(0)
  })

  it('preserves full body content verbatim from each source file', () => {
    const sp = loadSystemPrompt()
    const s = buildSystemString(sp)
    expect(s).toContain(sp.soul)
    expect(s).toContain(sp.agents)
    expect(s).toContain(sp.user)
    expect(sp.tools === null || s).toContain(sp.tools ?? '__no_tools__')
  })

  it('omits the tools section when tools is null (no orphan header)', () => {
    // v1.0.4 §1.1 — when tools.md is absent, the loader used to still emit
    // a stray '# TOOLS' header. Now there's no orphan heading at all.
    const sp = loadSystemPrompt()
    // Construct a synthetic SystemPrompt with no tools.
    const s = buildSystemString({
      soul: '# SOUL\n\nbody',
      agents: '# AGENTS — operating manual\n\nbody',
      user: '# STUDENT\n\nbody',
      userProfile: sp.userProfile,
      tools: null,
    })
    expect(s).not.toContain('# TOOLS')
    expect(s).not.toContain('# Tool Calling')
    // Confirm SOUL/AGENTS/STUDENT sections are still rendered exactly once.
    expect(s.match(/^# SOUL$/m)?.length).toBe(1)
    expect(s.match(/^# AGENTS — operating manual$/m)?.length).toBe(1)
    expect(s.match(/^# STUDENT$/m)?.length).toBe(1)
  })

  it('renders tools.md body when present (v0.7 content carried over)', () => {
    // Regression — mark_mistake / grammar / <tool> still flow through.
    const sp = loadSystemPrompt()
    const s = buildSystemString(sp)
    expect(s).toContain('mark_mistake')
    expect(s).toContain('grammar')
    expect(s).toMatch(/<tool>/)
  })
})

describe('assertHasH1 (v1.0.4 §3.4)', () => {
  it('passes when first non-empty line starts with "# <Title>"', () => {
    expect(() => assertHasH1('prompts/SOUL.md', '# SOUL\n\nbody text')).not.toThrow()
  })

  it('passes for H1 with extra text after the title word', () => {
    // e.g. AGENTS.md has '# AGENTS — operating manual'
    expect(() =>
      assertHasH1('prompts/AGENTS.md', '# AGENTS — operating manual\n\nbody'),
    ).not.toThrow()
  })

  it('passes when the body has leading blank lines before the H1', () => {
    // USER.md has YAML frontmatter, then blank line, then '# STUDENT'.
    // assertHasH1 only looks at the first non-empty line after trim, so the
    // blank line between `---` and `# STUDENT` is fine.
    expect(() => assertHasH1('prompts/USER.md', '\n\n# STUDENT\n\nbody')).not.toThrow()
  })

  it('throws when body has no H1', () => {
    expect(() => assertHasH1('prompts/SOUL.md', 'You are a tutor.\n\nMore body.')).toThrow(
      /must start with a '# <Title>' heading/,
    )
  })

  it('throws when H1 is missing the space after #', () => {
    // Defensive: only '# <word>' counts, not just '#word'.
    expect(() => assertHasH1('prompts/SOUL.md', '#SOUL\n\nbody')).toThrow(/must start with/)
  })

  it('throws when body is empty', () => {
    expect(() => assertHasH1('prompts/SOUL.md', '')).toThrow(/must start with/)
  })

  it('error message includes the offending file label', () => {
    expect(() => assertHasH1('prompts/foo.md', 'no heading here')).toThrow(/prompts\/foo\.md/)
  })
})

describe('loadUserFile (v1.0.5.3 §1.3 — first-run seed)', () => {
  beforeEach(() => {
    // Start each test with no USER.md present at all so the seed path runs.
    rmSync(SCRATCH, { recursive: true, force: true })
    mkdirSync(SCRATCH, { recursive: true })
    // Verify cleanup before test runs
    expect(existsSync(join(SCRATCH, 'USER.md'))).toBe(false)
  })

  it('seeds USER.md from the embedded example when AppData has no copy', () => {
    const userMdPath = join(SCRATCH, 'USER.md')
    expect(existsSync(userMdPath)).toBe(false)

    const result = loadUserFile()

    expect(result.seededFromExample).toBe(true)
    expect(existsSync(userMdPath)).toBe(true)
    // The seeded file should be parseable and match the example's profile
    expect(result.data.name).toBe('Sample Student')
    expect(result.data.age).toBe(13)
    expect(result.data.level).toBe('intermediate')
    expect(Array.isArray(result.data.interests)).toBe(true)
  })

  it('does not overwrite an existing USER.md on subsequent calls', () => {
    const userMdPath = join(SCRATCH, 'USER.md')

    // First call: seeds
    const first = loadUserFile()
    expect(first.seededFromExample).toBe(true)
    expect(existsSync(userMdPath)).toBe(true)

    // Second call: reads existing, does NOT re-seed
    const second = loadUserFile()
    expect(second.seededFromExample).toBe(false)
  })

  it('reads back the custom content of a pre-existing USER.md', () => {
    const userMdPath = join(SCRATCH, 'USER.md')
    const customContent = `---
name: Custom Kid
age: 9
level: beginner
goals:
  - Just chatting
interests:
  - Dinosaurs
---

# STUDENT

Custom kid is a 9-year-old dinosaur enthusiast.`
    writeFileSync(userMdPath, customContent, 'utf-8')

    const result = loadUserFile()
    expect(result.seededFromExample).toBe(false)
    expect(result.data.name).toBe('Custom Kid')
    expect(result.data.age).toBe(9)
    expect(result.data.level).toBe('beginner')
    expect(result.data.interests).toEqual(['Dinosaurs'])
  })
})

describe('updateUserSettings (v1.0.5.3 §1.3 — AppData writes)', () => {
  beforeEach(() => {
    // Wipe USER.md so each test starts from a clean state.
    rmSync(SCRATCH, { recursive: true, force: true })
    mkdirSync(SCRATCH, { recursive: true })
  })

  it('writes to AppData/USER.md (not prompts/)', async () => {
    const userMdPath = join(SCRATCH, 'USER.md')
    // Ensure the file exists (loadUserFile seeds if missing)
    loadUserFile()
    expect(existsSync(userMdPath)).toBe(true)

    await updateUserSettings({ voice_enabled: true })
    const after = readFileSync(userMdPath, 'utf-8')
    const parsed = matter(after)
    expect(parsed.data.voice_enabled).toBe(true)
  })

  it('seeds USER.md first if it does not exist', async () => {
    const userMdPath = join(SCRATCH, 'USER.md')
    expect(existsSync(userMdPath)).toBe(false)

    await updateUserSettings({ voice_enabled: true })

    expect(existsSync(userMdPath)).toBe(true)
    const after = readFileSync(userMdPath, 'utf-8')
    const parsed = matter(after)
    // Both seeded defaults AND the update should be present
    expect(parsed.data.voice_enabled).toBe(true)
    expect(parsed.data.name).toBe('Sample Student') // from embedded example
  })

  it('merges interests (append + dedupe on top of seeded defaults)', async () => {
    // Default example interests + 2 new ones; the second call appends 1 new +
    // 1 duplicate → final list has default + 3 unique new items.
    await updateUserSettings({ interests: ['Robots', 'Drawing'] })
    await updateUserSettings({ interests: ['Drawing', 'Piano'] }) // Drawing is a dup

    const parsed = matter(readFileSync(join(SCRATCH, 'USER.md'), 'utf-8'))
    const interests = parsed.data.interests as string[]
    // Last 3 should be our appended (in dedup order)
    expect(interests.slice(-3)).toEqual(['Robots', 'Drawing', 'Piano'])
    // And the seeded defaults should still be there
    expect(interests).toContain('Basketball')
  })

  it('writes core profile fields (name/age/level/goals) for the v1.0.5.4 wizard', async () => {
    await updateUserSettings({
      name: 'Newbie',
      age: 8,
      level: 'beginner',
      goals: ['Talk about cats', 'Learn greetings'],
    })

    const parsed = matter(readFileSync(join(SCRATCH, 'USER.md'), 'utf-8'))
    expect(parsed.data.name).toBe('Newbie')
    expect(parsed.data.age).toBe(8)
    expect(parsed.data.level).toBe('beginner')
    expect(parsed.data.goals).toEqual(['Talk about cats', 'Learn greetings'])
  })
})
