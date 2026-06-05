import { describe, expect, it } from 'vitest'
import { buildSystemContext } from '../../src/agent/context-injector.js'
import type { SessionState } from '../../src/agent/state-machine.js'

function makeState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    phase: 'WARM_UP',
    startedAt: 0,
    lastUserMsgAt: 0,
    elapsedMin: 2.3,
    silenceMin: 0.5,
    lastTransitionAt: 0,
    ...overrides,
  }
}

describe('buildSystemContext', () => {
  it('includes all 4 fields (phase / elapsed / silence / last transition)', () => {
    const out = buildSystemContext(makeState())
    expect(out).toContain('Phase: WARM_UP')
    expect(out).toContain('Elapsed: 2.3 min')
    expect(out).toContain('Silence: 0.5 min')
    expect(out).toContain('Last transition: 2.3 min ago (entered WARM_UP)')
  })

  it('starts with [System Context] header', () => {
    const out = buildSystemContext(makeState())
    expect(out.startsWith('[System Context]\n')).toBe(true)
  })

  it('shows Silence: 0.0 even when silence is zero (hint is always visible)', () => {
    const out = buildSystemContext(makeState({ silenceMin: 0 }))
    expect(out).toContain('Silence: 0.0 min')
  })
})
