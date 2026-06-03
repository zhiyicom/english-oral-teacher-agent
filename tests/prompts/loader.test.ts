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
})
