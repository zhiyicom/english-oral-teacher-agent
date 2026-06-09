import { describe, expect, it } from 'vitest'
import { buildSystemContext } from '../../src/agent/context-injector.js'
import type { LastReview } from '../../src/agent/retrieval.js'
import type { SessionState } from '../../src/agent/state-machine.js'
import type { Mistake } from '../../src/storage/mistakes.js'
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
    const out = buildSystemContext(makeState(), null, [], [], NOW)
    expect(out).not.toContain('Active topics')
  })

  it('activeTopics=undefined (omitted) also omits the segment', () => {
    const out = buildSystemContext(makeState(), null, undefined as unknown as TopicStat[], [], NOW)
    expect(out).not.toContain('Active topics')
  })

  it('one topic → "1 time, today"', () => {
    const out = buildSystemContext(makeState(), null, [makeTopicStat()], [], NOW)
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
      [],
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
    const out = buildSystemContext(makeState(), null, six, [], NOW)
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
      const out = buildSystemContext(makeState(), null, [{ ...base, lastDiscussedAt: ts }], [], NOW)
      expect(out).toContain(`(1 time, ${expected})`)
    }
  })

  it('keeps all v0.4 fields and v0.5 lastReview segment visible alongside active topics', () => {
    const out = buildSystemContext(makeState(), makeLastReview(), [makeTopicStat()], [], NOW)
    expect(out).toContain('Phase: WARM_UP')
    expect(out).toContain('Last transition:')
    expect(out).toContain('Last session (')
    expect(out).toContain('Active topics:')
  })

  it('segment appears AFTER lastReview (active topics is the outermost view)', () => {
    const out = buildSystemContext(makeState(), makeLastReview(), [makeTopicStat()], [], NOW)
    const lastReviewIdx = out.indexOf('Last session (')
    const activeTopicsIdx = out.indexOf('Active topics:')
    expect(lastReviewIdx).toBeGreaterThan(-1)
    expect(activeTopicsIdx).toBeGreaterThan(lastReviewIdx)
  })
})

describe('buildSystemContext (v0.7.1 recent mistakes)', () => {
  const NOW = new Date('2026-06-09T12:00:00.000Z')

  function makeMistake(overrides: Partial<Mistake> = {}): Mistake {
    return {
      id: 1,
      sessionId: 's1',
      original: 'I go to school yesterday',
      corrected: 'I went to school yesterday',
      category: 'grammar',
      ts: '2026-06-09T11:00:00.000Z',
      ...overrides,
    }
  }

  it('recentMistakes=[] omits the "Recent mistakes" segment entirely', () => {
    const out = buildSystemContext(makeState(), null, [], [], NOW)
    expect(out).not.toContain('Recent mistakes')
  })

  it('one mistake → header "Recent mistakes (N=1):" + 1 line', () => {
    const out = buildSystemContext(makeState(), null, [], [makeMistake()], NOW)
    expect(out).toContain('- Recent mistakes (N=1):')
    expect(out).toContain('  - "I go to school yesterday" → "I went to school yesterday" (grammar)')
  })

  it('three mistakes → "N=3" + 3 lines in order', () => {
    const mistakes = [
      makeMistake({
        id: 1,
        original: 'I go to school yesterday',
        corrected: 'I went to school yesterday',
        category: 'grammar',
      }),
      makeMistake({ id: 2, original: 'delicius', corrected: 'delicious', category: 'spelling' }),
      makeMistake({ id: 3, original: 'I am agree', corrected: 'I agree', category: 'grammar' }),
    ]
    const out = buildSystemContext(makeState(), null, [], mistakes, NOW)
    expect(out).toContain('- Recent mistakes (N=3):')
    expect(out).toContain('"I go to school yesterday" → "I went to school yesterday" (grammar)')
    expect(out).toContain('"delicius" → "delicious" (spelling)')
    expect(out).toContain('"I am agree" → "I agree" (grammar)')
  })

  it('five mistakes → "N=5" + all 5 lines (boundary)', () => {
    const mistakes = Array.from({ length: 5 }, (_, i) =>
      makeMistake({ id: i + 1, original: `m${i}`, corrected: `M${i}` }),
    )
    const out = buildSystemContext(makeState(), null, [], mistakes, NOW)
    expect(out).toContain('- Recent mistakes (N=5):')
    for (let i = 0; i < 5; i++) {
      expect(out).toContain(`"m${i}" → "M${i}"`)
    }
  })

  it('eight mistakes → truncated to top 5, header shows N=5', () => {
    const mistakes = Array.from({ length: 8 }, (_, i) =>
      makeMistake({ id: i + 1, original: `orig${i}`, corrected: `CORR${i}` }),
    )
    const out = buildSystemContext(makeState(), null, [], mistakes, NOW)
    expect(out).toContain('- Recent mistakes (N=5):')
    for (let i = 0; i < 5; i++) {
      expect(out).toContain(`"orig${i}" → "CORR${i}"`)
    }
    for (let i = 5; i < 8; i++) {
      expect(out).not.toContain(`"orig${i}" → "CORR${i}"`)
    }
  })

  it('special characters in original (quotes, backslashes) do not break the format', () => {
    const out = buildSystemContext(
      makeState(),
      null,
      [],
      [
        makeMistake({ original: 'with "quote"', corrected: 'no quote' }),
        makeMistake({ original: 'path\\to\\file', corrected: 'path/to/file' }),
      ],
      NOW,
    )
    expect(out).toContain('- Recent mistakes (N=2):')
    expect(out).toContain('"with "quote"" → "no quote" (grammar)')
    expect(out).toContain('"path\\to\\file" → "path/to/file" (grammar)')
  })

  it('section appears AFTER active topics and shares [System Context] header with the other segments', () => {
    const topic: TopicStat = {
      topic: 'minecraft',
      discussionCount: 1,
      firstDiscussedAt: '2026-06-09T10:00:00.000Z',
      lastDiscussedAt: '2026-06-09T10:00:00.000Z',
    }
    const out = buildSystemContext(makeState(), makeLastReview(), [topic], [makeMistake()], NOW)
    const phaseIdx = out.indexOf('Phase:')
    const lastReviewIdx = out.indexOf('Last session (')
    const activeTopicsIdx = out.indexOf('Active topics:')
    const mistakesIdx = out.indexOf('Recent mistakes (N=1):')
    expect(phaseIdx).toBeGreaterThan(-1)
    expect(lastReviewIdx).toBeGreaterThan(phaseIdx)
    expect(activeTopicsIdx).toBeGreaterThan(lastReviewIdx)
    expect(mistakesIdx).toBeGreaterThan(activeTopicsIdx)
  })
})
