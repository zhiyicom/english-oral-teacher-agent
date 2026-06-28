import { describe, expect, it } from 'vitest'
import { assertHasH1, buildSystemString, loadSystemPrompt } from '../../src/prompts/loader.js'

describe('loadSystemPrompt', () => {
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
})

describe('buildSystemString (v1.0.4 §1.1 — H1 single-source)', () => {
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

describe('loadSystemPrompt (v1.0.4 §3.4 — H1 runtime guard)', () => {
  it('passes when all 4 source files have H1', () => {
    // Sanity: real prompts files all start with their H1 → loadSystemPrompt
    // returns successfully.
    expect(() => loadSystemPrompt()).not.toThrow()
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
