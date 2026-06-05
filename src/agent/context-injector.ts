import type { SessionState } from './state-machine.js'

export function buildSystemContext(state: SessionState): string {
  const lastTransitionAgo = Math.max(0, state.elapsedMin - state.lastTransitionAt)
  return [
    '[System Context]',
    `- Phase: ${state.phase}`,
    `- Elapsed: ${state.elapsedMin.toFixed(1)} min`,
    `- Silence: ${state.silenceMin.toFixed(1)} min`,
    `- Last transition: ${lastTransitionAgo.toFixed(1)} min ago (entered ${state.phase})`,
  ].join('\n')
}
