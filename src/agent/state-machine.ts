import type { Clock } from './clock.js'

export type Phase = 'WARM_UP' | 'MAIN_ACTIVITY' | 'WRAP_UP' | 'END'

export interface PhaseTransition {
  phase: Phase
  at: number
  reason?: 'time' | 'user_stop' | 'phase_end'
}

export interface SessionState {
  phase: Phase
  startedAt: number
  lastUserMsgAt: number
  elapsedMin: number
  silenceMin: number
  lastTransitionAt: number
}

export type Event =
  | { type: 'INIT'; now: number }
  | { type: 'TICK' }
  | { type: 'USER_MSG' }
  | { type: 'USER_STOP' }

export function getPhase(elapsedMin: number): Phase {
  if (elapsedMin < 5) return 'WARM_UP'
  if (elapsedMin < 25) return 'MAIN_ACTIVITY'
  if (elapsedMin < 30) return 'WRAP_UP'
  return 'END'
}

export function initState(now: number): SessionState {
  return {
    phase: 'WARM_UP',
    startedAt: now,
    lastUserMsgAt: now,
    elapsedMin: 0,
    silenceMin: 0,
    lastTransitionAt: 0,
  }
}

export function applyEvent(state: SessionState, event: Event, clock: Clock): SessionState {
  const now = clock.now()
  const elapsedMin = (now - state.startedAt) / 60_000
  const silenceMin = (now - state.lastUserMsgAt) / 60_000

  switch (event.type) {
    case 'INIT': {
      return {
        phase: 'WARM_UP',
        startedAt: event.now,
        lastUserMsgAt: event.now,
        elapsedMin: 0,
        silenceMin: 0,
        lastTransitionAt: 0,
      }
    }

    case 'TICK': {
      // model C: phase 切换**仅**依赖时间。silence 仍计算（塞进 state 给
      // [System Context] 看），但不触发切 phase。
      const nextPhase = getPhase(elapsedMin)
      const transitioned = nextPhase !== state.phase
      return {
        ...state,
        phase: nextPhase,
        elapsedMin,
        silenceMin,
        lastTransitionAt: transitioned ? elapsedMin : state.lastTransitionAt,
      }
    }

    case 'USER_MSG': {
      return {
        ...state,
        lastUserMsgAt: now,
        silenceMin: 0,
      }
    }

    case 'USER_STOP': {
      return {
        ...state,
        phase: 'END',
        elapsedMin,
        silenceMin,
        lastTransitionAt: elapsedMin,
      }
    }
  }
}

const ALLOWED: Record<Phase, Phase[]> = {
  WARM_UP: ['MAIN_ACTIVITY', 'WRAP_UP', 'END'],
  MAIN_ACTIVITY: ['WRAP_UP', 'END'],
  WRAP_UP: ['END'],
  END: [],
}

export function validatePhaseTransition(from: Phase, to: Phase): void {
  if (from === to) return
  if (!ALLOWED[from].includes(to)) {
    throw new Error(`Invalid phase transition: ${from} → ${to}`)
  }
}
