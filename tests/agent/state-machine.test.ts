import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mockClock, realClock } from '../../src/agent/clock.js'
import {
  type Event,
  type Phase,
  type SessionState,
  applyEvent,
  getPhase,
  initState,
  validatePhaseTransition,
} from '../../src/agent/state-machine.js'

const MS_PER_MIN = 60_000

describe('getPhase (plan-mandated 8 cases)', () => {
  it.each([
    [0, 'WARM_UP'],
    [4, 'WARM_UP'],
    [6, 'MAIN_ACTIVITY'],
    [24, 'MAIN_ACTIVITY'],
    [26, 'WRAP_UP'],
    [29, 'WRAP_UP'],
    [30, 'END'],
    [31, 'END'],
  ] as const)('elapsedMin %i → %s', (m, expected) => {
    expect(getPhase(m)).toBe(expected)
  })
})

describe('USER_STOP', () => {
  it('any phase + USER_STOP → END', () => {
    const state = initState(0)
    const clock = mockClock(0)
    const next = applyEvent(state, { type: 'USER_STOP' }, clock)
    expect(next.phase).toBe('END')
  })

  it('USER_STOP from WARM_UP → END (case-insensitive trigger is CLI concern)', () => {
    const state: SessionState = {
      ...initState(0),
      phase: 'WARM_UP',
    }
    const clock = mockClock(10 * MS_PER_MIN)
    const next = applyEvent(state, { type: 'USER_STOP' }, clock)
    expect(next.phase).toBe('END')
  })

  it('USER_STOP from MAIN_ACTIVITY → END', () => {
    const state: SessionState = {
      ...initState(0),
      phase: 'MAIN_ACTIVITY',
    }
    const clock = mockClock(15 * MS_PER_MIN)
    const next = applyEvent(state, { type: 'USER_STOP' }, clock)
    expect(next.phase).toBe('END')
  })
})

describe('model C: silence does NOT trigger phase change', () => {
  // Build a state where elapsedMin is well within the current phase window,
  // and silenceMin is huge. TICK should keep the phase unchanged because
  // silence is a HINT, not a trigger.
  function tickWith(initialPhase: Phase, elapsedMin: number, silenceMin: number): SessionState {
    const now = elapsedMin * MS_PER_MIN + 60 * MS_PER_MIN // any base
    const state: SessionState = {
      phase: initialPhase,
      startedAt: now - elapsedMin * MS_PER_MIN,
      lastUserMsgAt: now - silenceMin * MS_PER_MIN,
      elapsedMin,
      silenceMin,
      lastTransitionAt: 0,
    }
    const clock = mockClock(now)
    return applyEvent(state, { type: 'TICK' }, clock)
  }

  it('WARM_UP at elapsed=2 min + silence=10 min → still WARM_UP', () => {
    const next = tickWith('WARM_UP', 2, 10)
    expect(next.phase).toBe('WARM_UP')
    expect(next.silenceMin).toBeCloseTo(10)
  })

  it('MAIN_ACTIVITY at elapsed=10 min + silence=10 min → still MAIN_ACTIVITY', () => {
    const next = tickWith('MAIN_ACTIVITY', 10, 10)
    expect(next.phase).toBe('MAIN_ACTIVITY')
    expect(next.silenceMin).toBeCloseTo(10)
  })

  it('WRAP_UP at elapsed=27 min + silence=10 min → still WRAP_UP (only USER_STOP or elapsed>=30 reaches END)', () => {
    const next = tickWith('WRAP_UP', 27, 10)
    expect(next.phase).toBe('WRAP_UP')
    expect(next.silenceMin).toBeCloseTo(10)
  })
})

describe('USER_MSG', () => {
  it('resets lastUserMsgAt to current now()', () => {
    const state = initState(0)
    const clock = mockClock(5 * MS_PER_MIN)
    const next = applyEvent(state, { type: 'USER_MSG' }, clock)
    expect(next.lastUserMsgAt).toBe(5 * MS_PER_MIN)
  })

  it('resets silenceMin to 0', () => {
    const state = initState(0)
    const clock = mockClock(5 * MS_PER_MIN)
    const next = applyEvent(state, { type: 'USER_MSG' }, clock)
    expect(next.silenceMin).toBe(0)
  })
})

describe('validatePhaseTransition', () => {
  it('WARM_UP → MAIN_ACTIVITY ok', () => {
    expect(() => validatePhaseTransition('WARM_UP', 'MAIN_ACTIVITY')).not.toThrow()
  })

  it('WARM_UP → WRAP_UP ok (admin jump)', () => {
    expect(() => validatePhaseTransition('WARM_UP', 'WRAP_UP')).not.toThrow()
  })

  it('WARM_UP → END ok (admin jump)', () => {
    expect(() => validatePhaseTransition('WARM_UP', 'END')).not.toThrow()
  })

  it('END → anything throws (END is terminal)', () => {
    expect(() => validatePhaseTransition('END', 'WARM_UP')).toThrow(/Invalid phase transition/)
    expect(() => validatePhaseTransition('END', 'MAIN_ACTIVITY')).toThrow()
    expect(() => validatePhaseTransition('END', 'WRAP_UP')).toThrow()
  })

  it('MAIN_ACTIVITY → WARM_UP throws (no backward)', () => {
    expect(() => validatePhaseTransition('MAIN_ACTIVITY', 'WARM_UP')).toThrow(
      /Invalid phase transition/,
    )
  })

  it('WRAP_UP → MAIN_ACTIVITY throws (no backward)', () => {
    expect(() => validatePhaseTransition('WRAP_UP', 'MAIN_ACTIVITY')).toThrow()
  })

  it('self-loop (same phase) is a no-op', () => {
    expect(() => validatePhaseTransition('WARM_UP', 'WARM_UP')).not.toThrow()
    expect(() => validatePhaseTransition('END', 'END')).not.toThrow()
  })
})

describe('purity', () => {
  it('applyEvent does not mutate input state', () => {
    const state = initState(0)
    const clock = mockClock(0)
    const snapshot = JSON.parse(JSON.stringify(state))
    applyEvent(state, { type: 'TICK' }, clock)
    expect(state).toEqual(snapshot)
  })

  it('same (state, event, clock) → same next state', () => {
    const state = initState(0)
    const clock = mockClock(3 * MS_PER_MIN)
    const a = applyEvent(state, { type: 'TICK' }, clock)
    const clock2 = mockClock(3 * MS_PER_MIN)
    const b = applyEvent(state, { type: 'TICK' }, clock2)
    expect(a).toEqual(b)
  })
})

describe('L2: 30-min session cycles through 4 phases (time-based only)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('30 min: 3 time-based transitions (MAIN_ACTIVITY@5, WRAP_UP@25, END@30)', () => {
    let state = initState(Date.now())
    const clock = realClock
    const history: Array<{ phase: Phase; at: number }> = [{ phase: state.phase, at: 0 }]

    for (let m = 0; m < 32; m++) {
      vi.advanceTimersByTime(MS_PER_MIN)
      const prev = state.phase
      state = applyEvent(state, { type: 'TICK' }, clock)
      if (state.phase !== prev) {
        history.push({ phase: state.phase, at: state.elapsedMin })
      }
    }

    expect(history).toEqual([
      { phase: 'WARM_UP', at: 0 },
      { phase: 'MAIN_ACTIVITY', at: 5 },
      { phase: 'WRAP_UP', at: 25 },
      { phase: 'END', at: 30 },
    ])
  })
})

describe('L2: invalid transition errors', () => {
  it('validatePhaseTransition(MAIN_ACTIVITY, WARM_UP) throws', () => {
    expect(() => validatePhaseTransition('MAIN_ACTIVITY', 'WARM_UP')).toThrow()
  })
})
