// src/agent/turn.ts
// v0.8.1 — extracted from src/cli.ts main loop (lines 335-828 of v0.7.7).
// Pure turn logic: input → LLM call → tool dispatch → student-facing text.
// Used by both the CLI (src/cli.ts) and the web server (src/server.ts) so
// they share 100% of the conversation logic.
//
// Design: `runTurn` is an async generator that yields `TurnEvent`s as the
// turn progresses, then returns a `TurnOutput` summarizing the state
// changes. The caller subscribes to events (CLI forwards to stderr, server
// forwards as SSE) and reads the final output for state updates.
//
// Streaming chunks are NOT yielded in v0.8.1 (the LLM response is buffered
// and emitted as a single `student-text` event). v0.8.3 will refactor to
// yield `text-chunk` events as the Anthropic SDK streams them. The
// current shape is intentionally forward-compatible: callers subscribe to
// events they care about and ignore the rest.
//
// See [v0.8-design.md §5](../../docs/sprint/v0.8-design.md#5-cli--server-共享turnts-refactor)
// for the refactor design and v0.7.7 cli.ts for the original implementation
// (this file is a 1:1 extraction with stderr.write() calls replaced by
// event yields; behavior is identical under CLI regression tests).

import { chatStreamWithRetry } from '../llm/retry.js'
import type { LLMClient, Message, SystemBlock, UsageChunk } from '../llm/types.js'
import type { RelevantSession } from '../memory/index.js'
import type { Embedder } from '../memory/index.js'
import type { SystemPrompt as LoaderSystemPrompt } from '../prompts/loader.js'
import type {
  MessagesDao,
  Mistake,
  SessionsDao,
  TopicStat,
  TopicStatsDao,
} from '../storage/index.js'
import type { MockClock } from './clock.js'
import {
  type Clock,
  type LastReview,
  type Phase,
  type PhaseTransition,
  type SessionState,
  type SummarizeHistoryResult,
  type TopicSelectResult,
  applyEvent,
  buildFinalSystemSegments,
  estimateMessagesTokens,
  estimateTokens,
  parseToolCall,
  stripToolCall,
  summarize,
  truncateHistory,
} from './index.js'
import type { ToolRegistry } from './tool-registry.js'

// ---------- v0.4 strict whole-sentence stop regex ----------
//   - keyword must be at sentence start (preceded by ^, [.!?]\s+, or \n)
//   - keyword must end the input (followed by [.!?\s]* only)
//   - "let's stop and continue" → stop is mid-sentence, NOT matched
//   - "I don't want to stop." → stop preceded by space (not [.!?]), NOT matched
//   - "stop", "Stop.", "okay. stop" → matched
const STOP_REGEX = /(?:^|[.!?]\s+|\n)(stop|quit|end|bye|done|结束|停)\b[.!?\s]*$/i

// ---------- Events yielded by runTurn ----------
// CLI forwards to stderr; server forwards as SSE (v0.8.3). The exact event
// sequence is asserted by L3 tests in tests/agent/turn.test.ts.
export type TurnEvent =
  | {
      type: 'phase'
      phase: Phase
      elapsed: number
      silence: number
      reason: 'time' | 'user_stop' | 'phase_end'
    }
  | {
      type: 'ctx' // per-turn log: phase + elapsed + silence. Fires every turn.
      phase: Phase
      elapsed: number
      silence: number
    }
  | {
      type: 'ctx-segment'
      phase: number
      last: number
      relevant: number
      active: number
      mistakes: number
    }
  | { type: 'ctx-block'; dynamic: string } // first-turn-only
  | { type: 'truncated'; dropped: number; newLength: number; estAfter: number }
  | {
      type: 'tokens'
      input: number
      output: number
      cacheRead: number
      cacheCreation: number
    }
  | { type: 'warn'; pct: number; budget: number }
  | { type: 'tool-call'; name: string; args: unknown; argSummary: string }
  | { type: 'tool-unknown'; name: string }
  | { type: 'tool-parse-error'; message: string }
  | { type: 'tool-dedup'; name: string; original: string }
  | { type: 'tool-execute-error'; name: string; message: string }
  | { type: 'tool-2nd-call'; name: string; argSummary: string }
  | {
      type: 'tool-summarize-result'
      targetTokens: number
      compressed: number | null // null = skipped (history too short)
      historyLength: number // current history length when this event fires (CLI uses for skipped log)
    }
  | { type: 'error'; classification: string; message: string } // V751-002 catch-all
  | { type: 'session-auto-saved'; sessionId: string } // V751-002 catch-all
  | { type: 'student-text'; text: string } // student-facing final text (CLI → stdout, server → SSE)
  | {
      type: 'done'
      endedReason: 'user_exit' | 'user_stop' | 'phase_end' | 'llm_error' | null
    }

export interface TurnDeps {
  env: { LLM_CONTEXT_BUDGET_TOKENS: number }
  clock: Clock
  client: LLMClient
  embedder: Embedder
  toolRegistry: ToolRegistry
  sessions: SessionsDao
  messages: MessagesDao
  topicStats: TopicStatsDao
  markedOriginals: Set<string>
}

export interface TurnInput {
  sessionId: string
  userInput: string
  state: SessionState
  history: Message[]
  phaseHistory: PhaseTransition[]
  firstPair: Message[]
  relevantPast: RelevantSession[]
  activeTopics: TopicStat[]
  recentMistakes: Mistake[]
  lastReview: LastReview | null
  isFirstTurn: boolean
  systemPrompt: LoaderSystemPrompt
  mockTime: boolean
}

export interface TurnOutput {
  state: SessionState
  history: Message[]
  phaseHistory: PhaseTransition[]
  firstPair: Message[]
  isFirstTurn: boolean
  endedReason: 'user_exit' | 'user_stop' | 'phase_end' | 'llm_error' | null
  sessionPersisted: boolean
}

// ---------- formatToolResult ----------
// v0.7.3 — format a memory_search result as a synthetic user message that
// the 2nd LLM call parses (student never sees this). v0.7.6 — added
// summarize_history and topic_select branches. Each tool's 2nd-call
// fixture matches on its own unique marker ([tool_result_v073] /
// [v076_history_summary] / [v076_topic_select_result]) so the fixtures
// never collide.
export function formatToolResult(name: string, result: unknown): string {
  if (name === 'summarize_history') {
    const r = result as SummarizeHistoryResult
    return `[v076_history_summary]\nHistory compressed to ~${r.targetTokens} tokens. Continue the conversation naturally.`
  }
  if (name === 'topic_select') {
    if (typeof result === 'object' && result !== null && 'error' in result) {
      const r = result as { error: string }
      return `[v076_topic_select_result]\n${r.error}. Pick a topic manually or continue.`
    }
    const r = result as TopicSelectResult
    return `[v076_topic_select_result]\nSelected topic: ${r.title} (slug=${r.slug}, ~${r.est_minutes} min). Start discussing it.`
  }
  if (name !== 'memory_search') {
    return `[tool_result_v073]\n[v073_followup_responder]\n[Tool result: ${name}]\n${JSON.stringify(result)}`
  }
  const sessions = result as RelevantSession[]
  if (!Array.isArray(sessions) || sessions.length === 0) {
    return '[tool_result_v073]\n[v073_followup_responder]\n[Tool result: memory_search]\nNo relevant past sessions found.'
  }
  const lines = sessions.map((s, i) => {
    const summary = s.summary.length > 80 ? `${s.summary.slice(0, 80)}...` : s.summary
    return `${i + 1}. ${s.daysAgo} day${s.daysAgo === 1 ? '' : 's'} ago: "${summary}" (keywords: ${s.keywords.join(', ')})`
  })
  return `[tool_result_v073]\n[v073_followup_responder]\n[Tool result: memory_search]\nTop ${sessions.length} most relevant past session${sessions.length === 1 ? '' : 's'}:\n${lines.join('\n')}`
}

// ---------- runTurn ----------
export async function* runTurn(
  input: TurnInput,
  deps: TurnDeps,
): AsyncGenerator<TurnEvent, TurnOutput, void> {
  // Mutable copies of the state. We mutate in place and return at the end
  // so the caller can persist them.
  const { sessionId, userInput, systemPrompt, mockTime } = input
  const state = input.state
  const history = input.history
  const phaseHistory = input.phaseHistory
  const firstPair = input.firstPair
  let isFirstTurn = input.isFirstTurn
  let sessionPersisted = false

  // ---------- 1. Pre-input processing (TICK + STOP detect) ----------
  const phaseBeforeTick = state.phase
  const newStateAfterTick = applyEvent(state, { type: 'TICK' }, deps.clock)
  let nextState: SessionState = newStateAfterTick
  if (nextState.phase !== phaseBeforeTick) {
    phaseHistory.push({ phase: nextState.phase, at: nextState.elapsedMin, reason: 'time' })
    yield {
      type: 'phase',
      phase: nextState.phase,
      elapsed: nextState.elapsedMin,
      silence: nextState.silenceMin,
      reason: 'time',
    }
  }

  // Time-based END: stop the loop, no more LLM calls
  if (nextState.phase === 'END') {
    yield {
      type: 'phase',
      phase: 'END',
      elapsed: nextState.elapsedMin,
      silence: nextState.silenceMin,
      reason: 'phase_end',
    }
    yield { type: 'done', endedReason: 'phase_end' }
    return {
      state: nextState,
      history,
      phaseHistory,
      firstPair,
      isFirstTurn,
      endedReason: 'phase_end',
      sessionPersisted,
    }
  }

  // Detect stop keyword (still call LLM this turn for the goodbye)
  const isStop = STOP_REGEX.test(userInput)
  if (isStop) {
    nextState = applyEvent(nextState, { type: 'USER_STOP' }, deps.clock)
    phaseHistory.push({ phase: 'END', at: nextState.elapsedMin, reason: 'user_stop' })
    yield {
      type: 'phase',
      phase: 'END',
      elapsed: nextState.elapsedMin,
      silence: nextState.silenceMin,
      reason: 'user_stop',
    }
  } else {
    nextState = applyEvent(nextState, { type: 'USER_MSG' }, deps.clock)
  }

  history.push({ role: 'user', content: userInput })
  deps.messages.append({ sessionId, role: 'user', content: userInput })

  // After the first system build, freeze the last-review / relevantPast
  // injection — subsequent turns build the system string from a fresh
  // state but without the review (which would otherwise drift / look
  // stale 25 min in).
  const wasFirstTurn = isFirstTurn
  isFirstTurn = false

  // ---------- 2. Build system ----------
  const sysSeg = buildFinalSystemSegments(
    systemPrompt,
    nextState,
    wasFirstTurn ? input.lastReview : null,
    input.activeTopics,
    input.recentMistakes,
    wasFirstTurn ? input.relevantPast : [],
  )
  const systemSize = estimateTokens(sysSeg.static) + estimateTokens(sysSeg.dynamic)
  yield {
    type: 'ctx-segment',
    phase: sysSeg.segments.phase,
    last: sysSeg.segments.last,
    relevant: sysSeg.segments.relevant,
    active: sysSeg.segments.active,
    mistakes: sysSeg.segments.mistakes,
  }

  // v0.7.5 + v0.7.6 B1 — sliding-window truncate with anchor pair.
  const { messages: truncMsgs, dropped } = truncateHistory(
    history,
    deps.env.LLM_CONTEXT_BUDGET_TOKENS,
    {
      systemSize,
      anchorPair: firstPair,
    },
  )
  if (dropped > 0) {
    const estAfter = estimateMessagesTokens(truncMsgs) + systemSize
    yield {
      type: 'truncated',
      dropped,
      newLength: truncMsgs.length,
      estAfter,
    }
    history.length = 0
    history.push(...truncMsgs)
  }

  const systemBlocks: SystemBlock[] = [
    { type: 'text', text: sysSeg.static, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: sysSeg.dynamic },
  ]

  // Per-turn ctx log: phase + elapsed + silence. L3 tests expect this on
  // every turn (see tests/agent/cli-integration.test.ts:118-122).
  yield {
    type: 'ctx',
    phase: nextState.phase,
    elapsed: nextState.elapsedMin,
    silence: nextState.silenceMin,
  }

  // First-turn-only: dump the full rendered [System Context] block (CLI
  // writes to stderr; server can use it for debug panels).
  if (wasFirstTurn) {
    yield { type: 'ctx-block', dynamic: sysSeg.dynamic }
  }

  // ---------- 3. LLM call with retry + catch-all ----------
  let response = ''
  let usage: UsageChunk | null = null
  try {
    const streamResult = await chatStreamWithRetry(deps.client, {
      systemBlocks,
      messages: history,
    })
    response = streamResult.response
    usage = streamResult.usage
  } catch (err) {
    // V751-002 — persistent LLM failure. Yield fallback text + auto-save.
    yield {
      type: 'error',
      classification: 'persistent_llm_failure',
      message: (err as Error).message,
    }
    const fallbackText =
      '\n[Teacher]: Sorry, I lost my train of thought. Could you say that again? 😊\n\n'
    yield { type: 'student-text', text: fallbackText }
    // Auto-save the session with a placeholder summary
    const allMessages = deps.messages.getBySession(sessionId)
    let summaryText = '(summarization failed after llm error)'
    let summaryKeywords: string[] = []
    try {
      const review = await summarize(
        allMessages.map((m) => ({ role: m.role, content: m.content })),
        deps.client,
      )
      summaryText = review.summary
      summaryKeywords = review.keywords
    } catch {
      // keep placeholder
    }
    const endedReason = isStop ? 'user_stop' : 'llm_error'
    deps.sessions.markEnded(sessionId, {
      phaseHistory,
      summary: summaryText,
      keywords: summaryKeywords,
      reason: endedReason,
    })
    sessionPersisted = true
    yield { type: 'session-auto-saved', sessionId }
    yield { type: 'done', endedReason }
    return {
      state: nextState,
      history,
      phaseHistory,
      firstPair,
      isFirstTurn,
      endedReason,
      sessionPersisted,
    }
  }

  // ---------- 4. Post-LLM: usage + 80% warn ----------
  if (usage) {
    yield {
      type: 'tokens',
      input: usage.inputTokens,
      output: usage.outputTokens,
      cacheRead: usage.cacheReadTokens,
      cacheCreation: usage.cacheCreationTokens,
    }
    const totalInput = usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens
    if (
      deps.env.LLM_CONTEXT_BUDGET_TOKENS > 0 &&
      totalInput / deps.env.LLM_CONTEXT_BUDGET_TOKENS >= 0.8
    ) {
      const pct = Math.round((totalInput / deps.env.LLM_CONTEXT_BUDGET_TOKENS) * 100)
      yield { type: 'warn', pct, budget: deps.env.LLM_CONTEXT_BUDGET_TOKENS }
    }
  }

  // ---------- 5. Parse + dispatch tool call ----------
  let parsed: ReturnType<typeof parseToolCall> = null
  try {
    parsed = parseToolCall(response)
  } catch (err) {
    yield { type: 'tool-parse-error', message: (err as Error).message }
  }

  let displayText = ''
  let endedReason: 'user_exit' | 'user_stop' | 'phase_end' | 'llm_error' | null = null
  if (endedReason === null && isStop) endedReason = 'user_stop'

  if (!parsed) {
    // No tool: stdout the LLM text as-is.
    displayText = response
    yield { type: 'student-text', text: `${displayText}\n\n` }
    history.push({ role: 'assistant', content: displayText })
    deps.messages.append({ sessionId, role: 'assistant', content: displayText })
  } else if (parsed.name === 'mark_mistake') {
    displayText = stripToolCall(response, parsed)
    const original = typeof parsed.args.original === 'string' ? parsed.args.original : ''
    if (original && deps.markedOriginals.has(original)) {
      yield { type: 'tool-dedup', name: parsed.name, original }
    } else {
      const tool = deps.toolRegistry.get(parsed.name)
      if (!tool) {
        yield { type: 'tool-unknown', name: parsed.name }
      } else {
        try {
          tool.execute(parsed.args)
          if (original) deps.markedOriginals.add(original)
          yield {
            type: 'tool-call',
            name: parsed.name,
            args: parsed.args,
            argSummary: original ? `original="${original}"` : '',
          }
        } catch (err) {
          yield {
            type: 'tool-execute-error',
            name: parsed.name,
            message: (err as Error).message,
          }
        }
      }
    }
    yield { type: 'student-text', text: `${displayText}\n\n` }
    history.push({ role: 'assistant', content: displayText })
    deps.messages.append({ sessionId, role: 'assistant', content: displayText })
  } else if (parsed.name === 'memory_search') {
    // A+B hybrid: execute, push result as synthetic user message, 2nd call.
    const tool = deps.toolRegistry.get(parsed.name)
    if (!tool) {
      yield { type: 'tool-unknown', name: parsed.name }
      displayText = stripToolCall(response, parsed)
      yield { type: 'student-text', text: `${displayText}\n\n` }
      history.push({ role: 'assistant', content: displayText })
      deps.messages.append({ sessionId, role: 'assistant', content: displayText })
    } else {
      yield {
        type: 'tool-call',
        name: parsed.name,
        args: parsed.args,
        argSummary: `top_k=${(parsed.args as { top_k?: number }).top_k ?? ''}`,
      }
      let result: unknown
      try {
        result = await tool.execute(parsed.args)
      } catch (err) {
        yield {
          type: 'tool-execute-error',
          name: parsed.name,
          message: (err as Error).message,
        }
        result = []
      }
      history.push({ role: 'assistant', content: response })
      const resultText = formatToolResult(parsed.name, result)
      history.push({ role: 'user', content: resultText })
      const followup = await deps.client.chat({ systemBlocks, messages: history })
      const argSummary = `top_k=${(parsed.args as { top_k?: number }).top_k ?? ''}`
      yield { type: 'tool-2nd-call', name: parsed.name, argSummary }
      // Safety strip 2nd-call response (don't recurse)
      let followupDisplay = followup.content
      const followupParsed = (() => {
        try {
          return parseToolCall(followup.content)
        } catch {
          return null
        }
      })()
      if (followupParsed) {
        followupDisplay = stripToolCall(followup.content, followupParsed)
      }
      yield { type: 'student-text', text: `${followupDisplay}\n\n` }
      history.push({ role: 'assistant', content: followupDisplay })
      deps.messages.append({ sessionId, role: 'assistant', content: followupDisplay })
    }
  } else if (parsed.name === 'summarize_history') {
    // v0.7.6 B2 — A+B marker tool, CLI does the history rewrite.
    const KEEP_RECENT = 6
    const tool = deps.toolRegistry.get(parsed.name)
    if (!tool) {
      yield { type: 'tool-unknown', name: parsed.name }
      displayText = stripToolCall(response, parsed)
      yield { type: 'student-text', text: `${displayText}\n\n` }
      history.push({ role: 'assistant', content: displayText })
      deps.messages.append({ sessionId, role: 'assistant', content: displayText })
    } else {
      yield {
        type: 'tool-call',
        name: parsed.name,
        args: parsed.args,
        argSummary: `target=${(parsed.args as { target_tokens?: number }).target_tokens ?? 500}`,
      }
      let result: SummarizeHistoryResult
      try {
        result = (await tool.execute(parsed.args)) as SummarizeHistoryResult
      } catch (err) {
        yield {
          type: 'tool-execute-error',
          name: parsed.name,
          message: (err as Error).message,
        }
        result = { kind: 'summarize_history', targetTokens: 500 }
      }
      // History rewrite: only compress if there's enough older history.
      const anchorLen = firstPair.length
      let compressed: number | null = null
      if (history.length > anchorLen + KEEP_RECENT + 2) {
        const older = history.slice(anchorLen, history.length - KEEP_RECENT)
        const recent = history.slice(history.length - KEEP_RECENT)
        let summaryText: string
        try {
          const review = await summarize(
            older.map((m) => ({ role: m.role, content: m.content })),
            deps.client,
          )
          summaryText = review.summary
        } catch (err) {
          yield {
            type: 'error',
            classification: 'summarize_failed',
            message: (err as Error).message,
          }
          summaryText = '(earlier conversation could not be summarized)'
        }
        const summaryMsg: Message = {
          role: 'assistant',
          content: `[Earlier conversation summary]: ${summaryText}`,
        }
        history.length = 0
        history.push(...firstPair, summaryMsg, ...recent)
        compressed = older.length
      }
      yield {
        type: 'tool-summarize-result',
        targetTokens: result.targetTokens,
        compressed,
        historyLength: history.length,
      }
      // A+B 2nd call
      history.push({ role: 'assistant', content: response })
      const resultText = formatToolResult(parsed.name, result)
      history.push({ role: 'user', content: resultText })
      const followup = await deps.client.chat({ systemBlocks, messages: history })
      yield {
        type: 'tool-2nd-call',
        name: parsed.name,
        argSummary: `target=${result.targetTokens}`,
      }
      let followupDisplay = followup.content
      const followupParsed = (() => {
        try {
          return parseToolCall(followup.content)
        } catch {
          return null
        }
      })()
      if (followupParsed) {
        followupDisplay = stripToolCall(followup.content, followupParsed)
      }
      yield { type: 'student-text', text: `${followupDisplay}\n\n` }
      history.push({ role: 'assistant', content: followupDisplay })
      deps.messages.append({ sessionId, role: 'assistant', content: followupDisplay })
    }
  } else if (parsed.name === 'topic_select') {
    // v0.7.6 D5 — A+B hybrid, pure compute.
    const tool = deps.toolRegistry.get(parsed.name)
    if (!tool) {
      yield { type: 'tool-unknown', name: parsed.name }
      displayText = stripToolCall(response, parsed)
      yield { type: 'student-text', text: `${displayText}\n\n` }
      history.push({ role: 'assistant', content: displayText })
      deps.messages.append({ sessionId, role: 'assistant', content: displayText })
    } else {
      yield {
        type: 'tool-call',
        name: parsed.name,
        args: parsed.args,
        argSummary: `phase=${(parsed.args as { phase?: string }).phase ?? 'WARM_UP'}, exclude=${(parsed.args as { exclude_recent_days?: number }).exclude_recent_days ?? 30}d`,
      }
      let result: TopicSelectResult | { error: string }
      try {
        result = tool.execute(parsed.args) as TopicSelectResult | { error: string }
      } catch (err) {
        yield {
          type: 'tool-execute-error',
          name: parsed.name,
          message: (err as Error).message,
        }
        result = { error: `tool execution failed: ${(err as Error).message}` }
      }
      history.push({ role: 'assistant', content: response })
      const resultText = formatToolResult(parsed.name, result)
      history.push({ role: 'user', content: resultText })
      const followup = await deps.client.chat({ systemBlocks, messages: history })
      const errOrSlug = 'error' in result ? 'error' : `slug=${result.slug}`
      yield { type: 'tool-2nd-call', name: parsed.name, argSummary: errOrSlug }
      let followupDisplay = followup.content
      const followupParsed = (() => {
        try {
          return parseToolCall(followup.content)
        } catch {
          return null
        }
      })()
      if (followupParsed) {
        followupDisplay = stripToolCall(followup.content, followupParsed)
      }
      yield { type: 'student-text', text: `${followupDisplay}\n\n` }
      history.push({ role: 'assistant', content: followupDisplay })
      deps.messages.append({ sessionId, role: 'assistant', content: followupDisplay })
    }
  } else {
    displayText = stripToolCall(response, parsed)
    yield { type: 'tool-unknown', name: parsed.name }
    yield { type: 'student-text', text: `${displayText}\n\n` }
    history.push({ role: 'assistant', content: displayText })
    deps.messages.append({ sessionId, role: 'assistant', content: displayText })
  }

  // ---------- 6. Capture first pair (anchor) + advance MOCK_TIME ----------
  if (firstPair.length === 0 && history.length >= 2) {
    const first = history[0]
    const second = history[1]
    if (first && second) {
      firstPair.push(first, second)
    }
  }
  if (mockTime) {
    ;(deps.clock as MockClock).advance(60_000)
  }

  yield { type: 'done', endedReason }
  return {
    state: nextState,
    history,
    phaseHistory,
    firstPair,
    isFirstTurn,
    endedReason,
    sessionPersisted,
  }
}
