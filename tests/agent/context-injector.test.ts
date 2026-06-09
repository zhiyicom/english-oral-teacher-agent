import { describe, expect, it } from 'vitest'
import { buildSystemContext } from '../../src/agent/context-injector.js'
import type { LastReview } from '../../src/agent/retrieval.js'
import type { SessionState } from '../../src/agent/state-machine.js'
import type { TopicStat } from '../../src/storage/topics.js'

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

describe('buildSystemContext (v0.6 active topics)', () => {
  const NOW = new Date('2026-06-09T12:00:00.000Z')

  function makeTopicStat(overrides: Partial<TopicStat> = {}): TopicStat {
    return {
      topic: 'minecraft',
      discussionCount: 1,
      firstDiscussedAt: '2026-06-09T10:00:00.000Z',
      lastDiscussedAt: '2026-06-09T10:00:00.000Z',
      ...overrides,
    }
  }

  it('activeTopics=[] omits the "Active topics" segment entirely', () => {
    const out = buildSystemContext(makeState(), null, [], NOW)
    expect(out).not.toContain('Active topics')
  })

  it('activeTopics=undefined (omitted) also omits the segment', () => {
    const out = buildSystemContext(makeState(), null, undefined as unknown as TopicStat[], NOW)
    expect(out).not.toContain('Active topics')
  })

  it('one topic → "1 time, today"', () => {
    const out = buildSystemContext(makeState(), null, [makeTopicStat()], NOW)
    expect(out).toContain('- Active topics: minecraft (1 time, today)')
  })

  it('multiple topics → single line, comma-separated, "N times" pluralization', () => {
    const out = buildSystemContext(
      makeState(),
      null,
      [
        makeTopicStat({ topic: 'minecraft', discussionCount: 1 }),
        makeTopicStat({
          topic: 'school',
          discussionCount: 3,
          lastDiscussedAt: '2026-06-07T12:00:00.000Z', // 2 days ago
        }),
      ],
      NOW,
    )
    expect(out).toContain(
      '- Active topics: minecraft (1 time, today), school (3 times, 2 days ago)',
    )
  })

  it('more than 5 topics → only top 5 are shown', () => {
    const six: TopicStat[] = Array.from({ length: 6 }, (_, i) =>
      makeTopicStat({ topic: `t${i}` as string }),
    )
    const out = buildSystemContext(makeState(), null, six, NOW)
    expect(out).toContain('t0')
    expect(out).toContain('t4')
    expect(out).not.toContain('t5')
  })

  it('formatDaysAgo: 0 → today, 1 → yesterday, 2+ → N days ago', () => {
    const base: TopicStat = makeTopicStat()
    const cases: Array<[string, string]> = [
      ['2026-06-09T11:00:00.000Z', 'today'], // 1h ago
      ['2026-06-08T12:00:00.000Z', 'yesterday'],
      ['2026-06-07T12:00:00.000Z', '2 days ago'],
      ['2026-06-01T12:00:00.000Z', '8 days ago'],
    ]
    for (const [ts, expected] of cases) {
      const out = buildSystemContext(makeState(), null, [{ ...base, lastDiscussedAt: ts }], NOW)
      expect(out).toContain(`(1 time, ${expected})`)
    }
  })

  it('keeps all v0.4 fields and v0.5 lastReview segment visible alongside active topics', () => {
    const out = buildSystemContext(makeState(), makeLastReview(), [makeTopicStat()], NOW)
    expect(out).toContain('Phase: WARM_UP')
    expect(out).toContain('Last transition:')
    expect(out).toContain('Last session (')
    expect(out).toContain('Active topics:')
  })

  it('segment appears AFTER lastReview (active topics is the outermost view)', () => {
    const out = buildSystemContext(makeState(), makeLastReview(), [makeTopicStat()], NOW)
    const lastReviewIdx = out.indexOf('Last session (')
    const activeTopicsIdx = out.indexOf('Active topics:')
    expect(lastReviewIdx).toBeGreaterThan(-1)
    expect(activeTopicsIdx).toBeGreaterThan(lastReviewIdx)
  })
})
