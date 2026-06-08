import { describe, expect, it } from 'vitest'
import { buildSystemContext } from '../../src/agent/context-injector.js'
import type { LastReview } from '../../src/agent/retrieval.js'
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

function makeLastReview(overrides: Partial<LastReview> = {}): LastReview {
  return {
    sessionId: 's1',
    startedAt: '2026-06-05T10:00:00.000Z',
    endedAt: '2026-06-05T10:05:00.000Z',
    durationMin: 5,
    summary: 'Student talked about Minecraft castles.',
    keywords: ['minecraft', 'castle', 'creeper'],
    daysAgo: 1,
    ...overrides,
  }
}

describe('buildSystemContext (v0.4 base)', () => {
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

describe('buildSystemContext (v0.5 last review)', () => {
  it('lastReview=null omits the "Last session" segment entirely', () => {
    const out = buildSystemContext(makeState(), null)
    expect(out).not.toContain('Last session')
  })

  it('lastReview=undefined (omitted) also omits the "Last session" segment', () => {
    const out = buildSystemContext(makeState())
    expect(out).not.toContain('Last session')
  })

  it('non-null lastReview appends "Last session (X day(s) ago, Y min): ..." line', () => {
    const out = buildSystemContext(makeState(), makeLastReview())
    expect(out).toContain(
      '- Last session (1 day ago, 5 min): Student talked about Minecraft castles.',
    )
  })

  it('non-null lastReview appends "Last session keywords: ..." line', () => {
    const out = buildSystemContext(makeState(), makeLastReview())
    expect(out).toContain('- Last session keywords: minecraft, castle, creeper')
  })

  it('uses singular "day" when daysAgo === 1', () => {
    const out = buildSystemContext(makeState(), makeLastReview({ daysAgo: 1 }))
    expect(out).toContain('(1 day ago,')
    expect(out).not.toContain('(1 days ago,')
  })

  it('uses plural "days" when daysAgo === 2', () => {
    const out = buildSystemContext(makeState(), makeLastReview({ daysAgo: 2 }))
    expect(out).toContain('(2 days ago,')
  })

  it('uses plural "days" when daysAgo === 0', () => {
    const out = buildSystemContext(makeState(), makeLastReview({ daysAgo: 0 }))
    expect(out).toContain('(0 days ago,')
  })

  it('falls back to "unknown" duration string when durationMin is null', () => {
    const out = buildSystemContext(makeState(), makeLastReview({ durationMin: null }))
    expect(out).toContain('(1 day ago, unknown):')
  })

  it('keeps all v0.4 fields visible alongside the last review segment', () => {
    const out = buildSystemContext(makeState(), makeLastReview())
    expect(out).toContain('Phase: WARM_UP')
    expect(out).toContain('Last transition:')
    expect(out).toContain('Last session (')
  })

  it('still appends the keywords line even when keywords array is empty', () => {
    const out = buildSystemContext(makeState(), makeLastReview({ keywords: [] }))
    expect(out).toContain('- Last session keywords:')
  })
})
