import { describe, expect, it } from 'vitest'
import { buildFinalSystem } from '../../src/agent/prompt-builder.js'
import type { SessionState } from '../../src/agent/state-machine.js'
import type { SystemPrompt } from '../../src/prompts/loader.js'
import type { Mistake } from '../../src/storage/mistakes.js'

const fakePrompt: SystemPrompt = {
  soul: 'You are a friendly English tutor.',
  agents: '## Rules\n- Always ask one follow-up question.',
  user: 'Student: Alex, 13, intermediate.',
  userProfile: {
    name: 'Alex',
    age: 13,
    level: 'intermediate',
    goals: ['fluency'],
    interests: ['minecraft'],
  },
  tools: null,
}

const fakeState: SessionState = {
  phase: 'WARM_UP',
  startedAt: 0,
  lastUserMsgAt: 0,
  elapsedMin: 0.5,
  silenceMin: 0.1,
  lastTransitionAt: 0,
}

describe('buildFinalSystem', () => {
  it('appends [System Context] block AFTER SOUL+AGENTS+STUDENT', () => {
    const out = buildFinalSystem(fakePrompt, fakeState)
    const soulIdx = out.indexOf('# SOUL')
    const ctxIdx = out.indexOf('[System Context]')
    expect(soulIdx).toBeGreaterThanOrEqual(0)
    expect(ctxIdx).toBeGreaterThan(soulIdx)
  })

  it('preserves SOUL/AGENTS/STUDENT content verbatim', () => {
    const out = buildFinalSystem(fakePrompt, fakeState)
    expect(out).toContain('You are a friendly English tutor.')
    expect(out).toContain('## Rules')
    expect(out).toContain('Student: Alex, 13, intermediate.')
  })

  it('contains current phase in the context block', () => {
    const out = buildFinalSystem(fakePrompt, { ...fakeState, phase: 'MAIN_ACTIVITY' })
    expect(out).toContain('Phase: MAIN_ACTIVITY')
  })

  it('passes recentMistakes through to the [System Context] block (v0.7.1)', () => {
    const mistakes: Mistake[] = [
      {
        id: 1,
        sessionId: 's1',
        original: 'I go to school yesterday',
        corrected: 'I went to school yesterday',
        category: 'grammar',
        ts: '2026-06-09T11:00:00.000Z',
      },
      {
        id: 2,
        sessionId: 's1',
        original: 'delicius',
        corrected: 'delicious',
        category: 'spelling',
        ts: '2026-06-09T11:01:00.000Z',
      },
    ]
    const out = buildFinalSystem(fakePrompt, fakeState, null, [], mistakes)
    expect(out).toContain('- Recent mistakes (N=2):')
    expect(out).toContain('"I go to school yesterday" → "I went to school yesterday" (grammar)')
    expect(out).toContain('"delicius" → "delicious" (spelling)')
  })
})
