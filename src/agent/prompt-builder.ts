import { type SystemPrompt, buildSystemString } from '../prompts/loader.js'
import { buildSystemContext } from './context-injector.js'
import type { SessionState } from './state-machine.js'

export function buildFinalSystem(systemPrompt: SystemPrompt, state: SessionState): string {
  return [buildSystemString(systemPrompt), '', buildSystemContext(state)].join('\n')
}
