import { describe, expect, it } from 'vitest'
import { buildSystemString, loadSystemPrompt } from '../../src/prompts/loader.js'

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

  it('buildSystemString concatenates sections with headers', () => {
    const sp = loadSystemPrompt()
    const s = buildSystemString(sp)
    expect(s).toContain('# SOUL')
    expect(s).toContain('# AGENTS')
    expect(s).toContain('# STUDENT')
    expect(s).toContain(sp.soul)
    expect(s).toContain(sp.agents)
  })

  it('loads prompts/tools.md when present (v0.7)', () => {
    const sp = loadSystemPrompt()
    expect(sp.tools).not.toBeNull()
    expect(sp.tools).toContain('mark_mistake')
    expect(sp.tools).toMatch(/<tool>/)
  })

  it('buildSystemString includes # TOOLS section with calling syntax (v0.7)', () => {
    const sp = loadSystemPrompt()
    const s = buildSystemString(sp)
    expect(s).toContain('# TOOLS')
    expect(s).toContain('mark_mistake')
    expect(s).toContain('grammar')
  })
})
