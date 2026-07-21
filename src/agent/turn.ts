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

import { logLLMRequest, logTurnDiagnostic } from '../llm/debug-log.js'
import { chatStreamWithRetry, chatStreamWithRetryGen } from '../llm/retry.js'
import { loadPhaseInstructions } from '../prompts/loader.js'
import {
  getCurrentMinTopicAge,
  getActiveTopic,
  getTopicTurnCount,
  incrementTopicTurnCount,
  isExplicitTopicSwitch,
  resetTopicTurnCount,
  setActiveTopic,
} from './topic-counter.js'

const PHASES = loadPhaseInstructions()
import type { ChatChunk, LLMClient, Message, SystemBlock, UsageChunk } from '../llm/types.js'
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
  parseBracketToolCall,
  parseToolCall,
  stripBracketToolCall,
  stripCodeFences,
  stripEchoedPhasePrefix,
  stripEchoedSystemNote,
  stripToolCall,
  summarize,
  truncateHistory,
} from './index.js'
import { isTurnOnTopic, pickFreshHints } from './topic-engine.js'
import { pickBlockedFallback } from './blocked-fallback.js'
import type { AdoptedTopic } from './topic-recorder.js'
import type { KeywordHit, Topic } from '../storage/topics.js'
import type { ToolRegistry } from './tool-registry.js'

// ---------- v0.4 strict whole-sentence stop regex ----------
//   - keyword must be at sentence start (preceded by ^, [.!?]\s+, or \n)
//   - keyword must end the input (followed by [.!?\s]* only)
//   - "let's stop and continue" → stop is mid-sentence, NOT matched
//   - "I don't want to stop." → stop preceded by space (not [.!?]), NOT matched
//   - "stop", "Stop.", "okay. stop" → matched
const STOP_REGEX = /(?:^|[.!?]\s+|\n)(stop|quit|end|bye|done|结束|停)\b[.!?\s]*$/i

// v1.0.9 §1.3 — extract WARM_UP keywords for Hook A contextBoost.
// Pure function: takes messages from history BEFORE the current user input
// (all WARM_UP turns, since Hook A fires on the transition tick) and
// returns a deduplicated list of "content word" tokens that may overlap
// with topic.keywords.
//
// Tokenization is intentionally light: split on whitespace + punctuation,
// drop tokens < 3 chars, drop pure-numeric tokens, dedup case-insensitively.
// No LLM, no embedder — pure string ops. Empty history → empty list (which
// is the safe "no boost" default the schema + engine already handle).
//
// v0.7.6 / v1.0.5 §B — the LLM was mining `# STUDENT` interests for
// opening material because topic_select only returned a bare title; this
// helper does NOT solve that, it just makes the auto-injected topic itself
// more relevant to what the student just talked about.
export function extractWarmUpKeywords(history: readonly Message[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const msg of history) {
    if (msg.role !== 'user') continue
    // Split on any non-letter/digit char (covers ASCII whitespace/punct
    // AND CJK punctuation like `，。！？`). CJK characters are all
    // `\p{L}`, so a run of CJK chars stays together as one "word"
    // (e.g. "我昨天玩了" stays as a single token).
    const tokens = msg.content.split(/[^\p{L}\p{N}]+/u)
    for (const raw of tokens) {
      const t = raw.trim().toLowerCase()
      if (t.length === 0) continue
      // Skip ASCII-only short words (a, an, I, to, ok, hi). CJK 1-2 char
      // words are perfectly meaningful in Chinese (我, 的, 波音) so the
      // length filter only applies to pure-ASCII letter runs.
      if (/^[a-z]+$/u.test(t) && t.length < 3) continue
      // Skip pure-numeric tokens (25, 737, 42). Mixed tokens like '3a'
      // are kept — they may be class IDs / model numbers worth matching.
      if (/^\d+$/u.test(t)) continue
      if (seen.has(t)) continue
      seen.add(t)
      out.push(t)
    }
  }
  // Cap output so we don't ship hundreds of tokens into a tool call.
  // 30 unique tokens is plenty to overlap with topic.keywords (which
  // typically have 3-6 entries) without bloating the prompt-side schema
  // or the engine's per-topic Set lookups.
  return out.slice(0, 30)
}

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
  | { type: 'text-chunk'; delta: string } // v0.8.5 — per-token delta (real streaming)
  | { type: 'student-text'; text: string } // student-facing final text (CLI → stdout, server → SSE)
  | {
      type: 'topic-adopted' // v1.0.7 §11 — fired when a topic is locked in for the session
      slug: string
      suggestedKeyword: string
      source: 'auto' | 'llm'
    }
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
  // v1.1.2 — full library of topics (Topic[]), read on demand for
  // pickFreshHints (topic layer's filterHardExclude + sortByCountAsc).
  // Required for tier ≥ 2 fresh-hint injection in the blocked branch.
  // Optional for callers that don't enable the hint (e.g. tests can
  // pass an empty array and stay on the v1.1.1 tier-1 path).
  topics?: Topic[]
  // v1.1.2 — keyword_hits snapshot for pickFreshHints (keyword layer's
  // hit_count === 0 filter). Same lifetime as TurnDeps: passed in once by
  // the caller (CLI / server / test harness). Optional; missing means
  // keyword layer of fresh hints is empty (tier 2 falls back to no hint).
  keywordHits?: KeywordHit[]
  // v1.1.2 — session-level block counter (ref object so the increment
  // inside runTurn propagates back to the caller across turns; a bare
  // `number` would copy-by-value and tier escalation would never
  // progress). Mutated in place by runTurn when the topic_select
  // blocked branch fires. Initialized to {value: 0} by the caller;
  // survives within a single session, NOT persisted across sessions
  // (T11 backlog). Optional for backward-compat — missing means the
  // blocked branch always stays at tier 1 (pure continuation).
  blockedCountRef?: { value: number }
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
  // v1.0.3 §1.3 — LLM-curated single keyword from previous session's
  // profile-extract. Used to focus the WARM_UP opener hint on the first
  // turn. Null when not available (first-ever session, server restart,
  // LLM failed to pick). Caller (CLI / Server) reads module-scoped state
  // and clears it on consume. Optional in the interface for tests that
  // don't care about WARM_UP behaviour.
  warmUpHook?: string | null
  // v1.0.7 §11 — adopted-topics ledger for this session. Mutated in place
  // by runTurn when a topic is locked in (Hook A = MAIN_ACTIVITY auto-inject,
  // Hook B = topic_select success). Caller owns the Map and reads it during
  // endSession to drive topic_stats / keyword_hits writes. Optional so older
  // tests still compile — defaults to an empty Map that nobody reads.
  // v1.0.9 §1.4 — entries now carry onTopicTurns + keywords + description
  // so end-of-turn logic can run `isTurnOnTopic` and recorder can gate
  // writes on ADOPTION_MIN_TURNS.
  adoptedTopics?: Map<string, AdoptedTopic>
  // v1.1.2 T5 — set to true by the caller when the previous turn's
  // topic_select was blocked. Injected into [System Context] as a
  // one-shot anti-spam signal so the LLM does NOT retry topic_select.
  // Reset to false after the turn where it was consumed.
  topicSelectBlockedLastTurn?: boolean
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
  // If the session is already in END phase (LLM said goodbye), any further
  // student message ends the session immediately — no more LLM calls.
  if (state.phase === 'END') {
    yield { type: 'done', endedReason: 'phase_end' }
    return {
      state,
      history,
      phaseHistory,
      firstPair,
      isFirstTurn,
      endedReason: 'phase_end',
      sessionPersisted,
    }
  }

  const phaseBeforeTick = state.phase
  const newStateAfterTick = applyEvent(state, { type: 'TICK' }, deps.clock)
  let nextState: SessionState = newStateAfterTick
  let phaseJustChanged = false
  if (nextState.phase !== phaseBeforeTick) {
    phaseJustChanged = true
    phaseHistory.push({ phase: nextState.phase, at: nextState.elapsedMin, reason: 'time' })
    yield {
      type: 'phase',
      phase: nextState.phase,
      elapsed: nextState.elapsedMin,
      silence: nextState.silenceMin,
      reason: 'time',
    }
  }

  // v0.8.5 — catch-up WRAP_UP: if long silence caused us to jump from
  // WARM_UP/MAIN_ACTIVITY straight to END (skipping WRAP_UP entirely),
  // give the LLM one WRAP_UP round to summarize before the final goodbye.
  // The next turn will naturally reach END.
  if (
    nextState.phase === 'END' &&
    (phaseBeforeTick === 'WARM_UP' || phaseBeforeTick === 'MAIN_ACTIVITY') &&
    nextState.silenceMin >= 10
  ) {
    nextState = { ...nextState, phase: 'WRAP_UP' as const }
    phaseHistory.push({ phase: 'WRAP_UP', at: nextState.elapsedMin, reason: 'time' })
    yield {
      type: 'phase',
      phase: 'WRAP_UP',
      elapsed: nextState.elapsedMin,
      silence: nextState.silenceMin,
      reason: 'time',
    }
  }

  // Detect stop keyword or time-based END.
  // Both go through the LLM so the student gets a proper goodbye message.
  const isStop = STOP_REGEX.test(userInput)
  const isTimeEnd = nextState.phase === 'END'

  if (isStop || isTimeEnd) {
    const reason = isTimeEnd ? 'phase_end' : 'user_stop'
    if (isTimeEnd && !isStop) {
      // Time-based END: yield the phase transition first
      yield {
        type: 'phase',
        phase: 'END',
        elapsed: nextState.elapsedMin,
        silence: nextState.silenceMin,
        reason,
      }
    }
    nextState = applyEvent(nextState, { type: 'USER_STOP' }, deps.clock)
    phaseHistory.push({ phase: 'END', at: nextState.elapsedMin, reason })
    yield {
      type: 'phase',
      phase: 'END',
      elapsed: nextState.elapsedMin,
      silence: nextState.silenceMin,
      reason,
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
    input.topicSelectBlockedLastTurn ?? false,
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
  // v0.8.5 — uses chatStreamWithRetryGen for true text-chunk streaming.

  // Phase change / first turn / normal turn: inject behavioral hints into
  // the user message. Chat models ignore system context, so these go inline.
  const phaseReminder = PHASES.reminder[nextState.phase] ?? ''
  const phaseContext = PHASES.context[nextState.phase] ?? ''
  const lastMsg = history[history.length - 1]
  let callMessages = history
  if (lastMsg && lastMsg.role === 'user') {
    if (phaseJustChanged && phaseContext) {
      // Phase change to MAIN_ACTIVITY: auto-select a topic from the library.
      // The topic_select tool returns a topic slug + title; we synthesize a
      // user message that forces the LLM to discuss that topic.
      // Text instructions are consistently ignored by chat models — tool
      // results embedded as messages are not.
      if (nextState.phase === 'MAIN_ACTIVITY') {
        try {
          const topicTool = deps.toolRegistry.get('topic_select')
          if (topicTool) {
            // v1.0.9 §1.3 — extract keywords from WARM_UP history so the
            // selection engine can soft-boost topics related to what the
            // student just talked about. Pure string extraction, no LLM.
            // Falls back to [] when WARM_UP was empty (server first-turn
            // hook / fresh session) — [] is the "no boost" default.
            const warmUpHistory = history.slice(0, -1)
            const contextKeywords = extractWarmUpKeywords(warmUpHistory)
            const topicResult = (await topicTool.execute({
              phase: 'MAIN_ACTIVITY',
              exclude_recent_days: 30,
              ...(contextKeywords.length > 0 ? { context_keywords: contextKeywords } : {}),
            })) as
              | {
                  slug?: string
                  title?: string
                  error?: string
                  suggested_keyword?: string
                  keywords?: string[]
                }
              | { error: string }
            if ('slug' in topicResult && topicResult.slug && !('error' in topicResult)) {
              const topicMsg = `[TOPIC: ${topicResult.slug}] We are now in the main activity phase. Introduce the topic "${topicResult.title ?? topicResult.slug}" to the student. Teach 2-3 relevant vocabulary words. Ask open-ended questions — the student should talk 70% of the time.`
              callMessages = [
                ...history.slice(0, -1),
                { role: 'user' as const, content: topicMsg },
                lastMsg,
              ]
              // v1.0.7 §11.4 — Hook A: auto-inject is a real adoption. Record
              // the slug in the ledger so the END pipeline writes a
              // topic_stats row and the dedup signals start to update.
              // v1.0.9 §1.4 — capture keywords + description so end-of-turn
              // `isTurnOnTopic` can check this entry without re-reading the
              // topics table; onTopicTurns starts at 0 and accumulates via
              // the bump logic below.
              const suggestedKw = topicResult.suggested_keyword ?? ''
              const injectedSlug = topicResult.slug
              input.adoptedTopics?.set(injectedSlug, {
                suggestedKeyword: suggestedKw,
                source: 'auto',
                onTopicTurns: 0,
                keywords: topicResult.keywords ?? [],
                description: topicResult.title ?? null,
              })
              setActiveTopic(sessionId, injectedSlug)
              yield {
                type: 'topic-adopted',
                slug: topicResult.slug,
                suggestedKeyword: suggestedKw,
                source: 'auto',
              }
            } else {
              // Fallback: use phase context text
              const instruction = phaseContext.replace(/## /g, '')
              callMessages = [
                ...history.slice(0, -1),
                { role: 'user' as const, content: `[PHASE TRANSITION — ${instruction}]` },
                lastMsg,
              ]
            }
          }
        } catch {
          // Tool failed — fallback to text instruction
          const instruction = phaseContext.replace(/## /g, '')
          callMessages = [
            ...history.slice(0, -1),
            { role: 'user' as const, content: `[PHASE TRANSITION — ${instruction}]` },
            lastMsg,
          ]
        }
      } else {
        // Other phase transitions: use standalone text instruction
        const instruction = phaseContext.replace(/## /g, '')
        callMessages = [
          ...history.slice(0, -1),
          { role: 'user' as const, content: `[PHASE TRANSITION — ${instruction}]` },
          lastMsg,
        ]
      }
    } else {
      // Same phase: prepend a short reminder or first-turn warmup hint.
      // First-turn warmup uses a standalone message (not prefix) for maximum
      // impact — same strategy as phase transitions.
      if (wasFirstTurn && input.lastReview?.summary) {
        const summary = input.lastReview.summary
        // v1.0.4 §1.2 — align keyword count with Block 1 (6 items, not 4)
        // so both segments show the same keywords in the same order.
        const kws = (input.lastReview.keywords ?? []).slice(0, 6).join(', ')
        // v1.0.3 §1.3 — when the previous session's profile-extract produced
        // a focused opener keyword, prepend a directive seed line. Falls
        // back to the original "make a natural connection" text when no
        // hook is available (first-ever session, server restart, LLM failed).
        const opener = input.warmUpHook
          ? `Your opener topic for today: "${input.warmUpHook}". Make the first question naturally about this — then chat around the student's interests.`
          : `Greet the student first, then make a natural connection to something from last session before moving to a new topic.`
        const hint = [
          `Last session (${input.lastReview.daysAgo} days ago): ${summary}`,
          `Keywords: ${kws}`,
          opener,
        ].join('\n')
        process.stderr.write(`[turn] WARM_UP hint as standalone message\n`)
        callMessages = [
          ...history.slice(0, -1),
          { role: 'user' as const, content: hint },
          lastMsg,
        ]
      } else if (phaseReminder) {
        const modified = { ...lastMsg, content: `[Phase: ${nextState.phase} — ${phaseReminder}] ${lastMsg.content}` }
        callMessages = [...history.slice(0, -1), modified]
      }
    }
  }

  logLLMRequest(sessionId, phaseHistory.length, systemBlocks, callMessages)

  let response = ''
  let usage: UsageChunk | null = null
  try {
    const stream = chatStreamWithRetryGen(deps.client, { systemBlocks, messages: callMessages })
    for await (const chunk of stream) {
      if (chunk.type === 'text') {
        response += chunk.delta
        yield { type: 'text-chunk', delta: chunk.delta }
      } else if (chunk.type === 'usage') {
        usage = chunk
      }
    }
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
    const endedReason = isTimeEnd ? 'phase_end' : isStop ? 'user_stop' : 'llm_error'
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

  // v1.1.2 §1.5 P0-B — strip markdown code fences BEFORE any other
  // processing. If the LLM wraps its entire response (or just the tool
  // call) in ``` fences, strip them first so the inner content can be
  // parsed normally by parseToolCall / other strippers below.
  response = stripCodeFences(response)

  // v1.1.1 P0-#4 — strip any echoed "[Phase: ...]" prefix BEFORE the
  // diagnostic log captures rawHead (so the log shows the post-strip
  // value, matching what we actually send to the student) and BEFORE
  // parseToolCall (so the stripper-deleted prefix doesn't trip the
  // <tool> regex). The LLM occasionally paraphrases the [System Context]
  // block as "[Phase: PHASE — reminder]" and we'd otherwise leak the
  // metadata into the student UI.
  //
  // v1.1.2 P0-α — also strip "[System note: ...]" (LLM-self-narrated
  // reminders from 7/16 session 7132fcc9). Order: System note first
  // (paranoid future-proofing for nested `[System note: now is
  // [Phase: MAIN_ACTIVITY]]`), Phase second.
  const systemNoteStrip = stripEchoedSystemNote(response)
  const systemNoteStripped = systemNoteStrip.stripped
  if (systemNoteStripped) response = systemNoteStrip.cleaned

  const rawEchoesPhasePrefix = /^\[Phase:/.test(response.trim())
  const phasePrefixStrip = stripEchoedPhasePrefix(response)
  const phasePrefixStripped = phasePrefixStrip.stripped
  if (phasePrefixStripped) response = phasePrefixStrip.cleaned

  // v1.0.1 diagnostic — record what the 1st-call LLM actually produced,
  // before any tool parsing / stripping. Used to track down "no reply"
  // cases where the Web UI shows nothing.
  logTurnDiagnostic(sessionId, phaseHistory.length, nextState.phase, {
    ev: 'llm_done',
    rawLen: response.length,
    rawHead: response.slice(0, 300),
    rawTail: response.length > 400 ? response.slice(-100) : '',
    rawEchoesPhasePrefix,
    phasePrefixStripped,
    // v1.1.2 P0-α — stripped the System-note echo prefix on this turn.
    systemNoteStripped,
  })

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
  if (isTimeEnd) endedReason = 'phase_end'
  else if (isStop) endedReason = 'user_stop'

  if (!parsed) {
    // v1.1.1 P0-#2 — bracket-form fallback: when LLM forgets <tool>...</tool>
    // and emits "[Tool call: name]\n{json}" instead, still try to parse it
    // as a real tool call. If parse succeeds, fall through to the
    // tool-specific branches below (don't `else` here — we want the chain
    // to continue). If parse fails (incl. malformed JSON), strip the
    // bracket syntax defensively so the student never sees the raw
    // "[Tool call: ...]" leak in their UI.
    const bracketParsed = parseBracketToolCall(response)
    if (bracketParsed) {
      parsed = bracketParsed
    } else {
      response = stripBracketToolCall(response)
    }
  }

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
      const strippedPrefix = stripToolCall(response, parsed).trim()
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
      logTurnDiagnostic(sessionId, phaseHistory.length, nextState.phase, {
        ev: 'tool_2nd_call_done',
        toolName: parsed.name,
        followupLen: followup.content.length,
        followupHead: followup.content.slice(0, 200),
        followupEchoesPhasePrefix: /^\[Phase:/.test(followup.content.trim()),
      })
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
      // v1.1.0 — preserve stripped text from the 1st response
      if (strippedPrefix) {
        followupDisplay = `${strippedPrefix}\n\n${followupDisplay}`
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
      const strippedPrefix = stripToolCall(response, parsed).trim()
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
      logTurnDiagnostic(sessionId, phaseHistory.length, nextState.phase, {
        ev: 'tool_2nd_call_done',
        toolName: parsed.name,
        followupLen: followup.content.length,
        followupHead: followup.content.slice(0, 200),
        followupEchoesPhasePrefix: /^\[Phase:/.test(followup.content.trim()),
      })
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
      if (strippedPrefix) {
        followupDisplay = `${strippedPrefix}\n\n${followupDisplay}`
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
      // v1.1.0 — preserve stripped text from the 1st response (e.g. corrections
      // or natural transition text that appears before the <tool> tag) so it
      // isn't lost when the 2nd-call response replaces it.
      const strippedPrefix = stripToolCall(response, parsed).trim()
      // v1.0.2 — enforce MIN_TOPIC_AGE so the LLM can't ping-pong between
      // topics every turn. counter tracks user turns since the last
      // successful topic_select (or session start). Explicit user request
      // ("switch topic", "换个话题") bypasses the gate. Default threshold
      // is 5 user turns; override via TOPIC_AGE_MIN env var (0 disables).
      const minAge = getCurrentMinTopicAge()
      // Read from history (not callMessages) — callMessages may have been
      // mutated by phase-transition / first-turn hint injection, but the
      // raw user input is always the last entry of history.
      const lastUserInput = history[history.length - 1]?.content ?? ''
      const explicitSwitch = isExplicitTopicSwitch(lastUserInput)
      const currentCount = getTopicTurnCount(sessionId)
      let result: TopicSelectResult | { error: string }
      let blocked = false
      if (minAge > 0 && !explicitSwitch && currentCount < minAge) {
        const remaining = minAge - currentCount
        result = {
          error: `Topic too young (${currentCount}/${minAge} user turns on current topic). Stay on this topic for ${remaining} more turn${remaining > 1 ? 's' : ''}. The user has not asked to switch.`,
        }
        blocked = true
        logTurnDiagnostic(sessionId, phaseHistory.length, nextState.phase, {
          ev: 'topic_select_blocked',
          count: currentCount,
          minAge,
          lastUserInput: lastUserInput.slice(0, 80),
        })
      } else {
        yield {
          type: 'tool-call',
          name: parsed.name,
          args: parsed.args,
          argSummary: `phase=${(parsed.args as { phase?: string }).phase ?? 'WARM_UP'}, exclude=${(parsed.args as { exclude_recent_days?: number }).exclude_recent_days ?? 30}d`,
        }
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
        if (!('error' in result)) {
          // Successful topic switch — reset counter so the new topic starts
          // fresh (0 user turns on it yet).
          resetTopicTurnCount(sessionId)
          // v1.0.7 §11.5 — Hook B: record the LLM-chosen topic in the ledger
          // (dedup by slug). `suggested_keyword` is the soft hint the tool
          // returns; fall back to the first keyword if missing.
          const successResult = result as TopicSelectResult
          const suggestedKw =
            successResult.suggested_keyword ?? successResult.keywords?.[0] ?? ''
          if (!input.adoptedTopics?.has(successResult.slug)) {
            input.adoptedTopics?.set(successResult.slug, {
              suggestedKeyword: suggestedKw,
              source: 'llm',
              onTopicTurns: 0,
              keywords: successResult.keywords ?? [],
              description: successResult.title ?? null,
            })
            setActiveTopic(sessionId, successResult.slug)
            yield {
              type: 'topic-adopted',
              slug: successResult.slug,
              suggestedKeyword: suggestedKw,
              source: 'llm',
            }
          }
        }
      }

      // v1.1.1 P1-#5/#6 — when blocked, short-circuit the 2nd LLM call to
      // avoid both (a) duplicated followup text (strippedPrefix + 2nd-call
      // followup both get pushed into history) and (b) the "复读机" effect
      // where the 2nd-call LLM tends to repeat the previous turn's wording.
      // v1.1.2 P1-A — three-tier fallback ladder (pickBlockedFallback) so
      //   the same sentence isn't repeated 4-5× in a row.
      // v1.1.2 P2-A — tier ≥ 2 also attaches topic+keyword fresh hints
      //   (pickFreshHints) so the LLM can see what's unused in the
      //   library instead of improvising from memory.
      if (blocked) {
        if (deps.blockedCountRef === undefined) deps.blockedCountRef = { value: 0 }
        deps.blockedCountRef.value += 1
        const blockedCount = deps.blockedCountRef.value
        const fallback = pickBlockedFallback(blockedCount - 1)
        displayText = strippedPrefix || fallback

        // Tier ≥ 2 → attach fresh hints. Tier 1 stays clean (pure
        // continuation, no system-y phrasing, no hint). Caller controls
        // visibility: hintSuffix goes into the student-facing student-text
        // AND into deps.messages (persistent row), but NOT into the LLM
        // input.history (LLM should not see system scaffolding).
        let hintSuffix = ''
        let freshHintLayer: 'none' | 'keyword' | 'topic+keyword' = 'none'
        let freshHintInjected = false
        if (blockedCount - 1 >= 1 && deps.topics && deps.topics.length > 0) {
          const fresh = pickFreshHints({
            topics: deps.topics,
            stats: deps.topicStats.all(),
            keywordStats: deps.keywordHits ?? [],
            excludeDays: 30,
            topicLimit: 3,
            keywordLimit: 5,
          })
          const kwList = fresh.keywords.join(', ')
          if (fresh.keywords.length > 0) {
            if (blockedCount - 1 >= 2 && fresh.topics.length > 0) {
              const tList = fresh.topics
                .map((t) => t.description?.trim() || t.name)
                .join(', ')
              hintSuffix = `\n\nFresh angles to try: ${kwList}.\n\nTry switching to: ${tList}.`
              freshHintLayer = 'topic+keyword'
            } else {
              hintSuffix = `\n\nFresh angles to try: ${kwList}.`
              freshHintLayer = 'keyword'
            }
            freshHintInjected = true
          }
        }

        const tier =
          blockedCount >= 3 ? 3 : blockedCount
        yield {
          type: 'student-text',
          text: `${displayText}${hintSuffix}\n\n`,
        }
        history.push({ role: 'assistant', content: displayText })
        deps.messages.append({
          sessionId,
          role: 'assistant',
          content: `${displayText}${hintSuffix}`,
        })
        logTurnDiagnostic(sessionId, phaseHistory.length, nextState.phase, {
          ev: 'turn_done',
          toolName: parsed.name,
          lastHistoryRole: 'assistant',
          lastHistoryLen: displayText.length,
          lastHistoryHead: displayText.slice(0, 200),
          endedReason: null,
          blockedCount,
          fallbackTier: tier,
          freshHintInjected,
          freshHintLayer,
        })
        yield {
          type: 'tool-2nd-call',
          name: parsed.name,
          argSummary: `blocked tier=${tier} layer=${freshHintLayer}`,
        }
        // Skip the normal 2nd-call path below.
      } else {
        history.push({ role: 'assistant', content: response })
        const resultText = formatToolResult(parsed.name, result)
        history.push({ role: 'user', content: resultText })
        const followup = await deps.client.chat({ systemBlocks, messages: history })
        logTurnDiagnostic(sessionId, phaseHistory.length, nextState.phase, {
          ev: 'tool_2nd_call_done',
          toolName: parsed.name,
          followupLen: followup.content.length,
          followupHead: followup.content.slice(0, 200),
          followupEchoesPhasePrefix: /^\[Phase:/.test(followup.content.trim()),
          blocked,
        })
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
        // v1.1.0 — prepend the stripped text so corrections/natural transitions
        // from the 1st response are visible alongside the 2nd-call response.
        if (strippedPrefix) {
          followupDisplay = `${strippedPrefix}\n\n${followupDisplay}`
        }
        yield { type: 'student-text', text: `${followupDisplay}\n\n` }
        history.push({ role: 'assistant', content: followupDisplay })
        deps.messages.append({ sessionId, role: 'assistant', content: followupDisplay })
      }
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

  // v1.0.1 diagnostic — record what was actually saved to history and
  // what was yielded to the client. Pairs with `llm_done` above to
  // diagnose the "no reply" / empty-bubble symptom.
  const lastHist = history[history.length - 1]
  logTurnDiagnostic(sessionId, phaseHistory.length, nextState.phase, {
    ev: 'turn_done',
    toolName: parsed?.name ?? null,
    lastHistoryRole: lastHist?.role,
    lastHistoryLen: lastHist?.content.length ?? 0,
    lastHistoryHead: (lastHist?.content ?? '').slice(0, 200),
    endedReason,
  })

  // v1.0.9 §1.4 — write-on-adoption bump. Run `isTurnOnTopic` against
  // the currently active topic (set by Hook A / Hook B above). On match,
  // bump `onTopicTurns` in the ledger entry; on miss, freeze (do not
  // reset — a later on-topic turn should still count).
  const activeSlug = getActiveTopic(sessionId)
  if (activeSlug && input.adoptedTopics) {
    const entry = input.adoptedTopics.get(activeSlug)
    if (entry) {
      const activeTopic: Topic = {
        name: activeSlug,
        keywords: entry.keywords,
        description: entry.description,
        createdAt: '',
      }
      if (isTurnOnTopic(activeTopic, userInput, displayText)) {
        entry.onTopicTurns += 1
      }
    }
  }

  // v1.0.2 — increment the topic-age counter for this user turn. Counter
  // is reset to 0 when topic_select succeeds (above). V751-002 paths
  // return early before reaching this line and don't increment — a
  // failed turn doesn't count as a real turn on the topic.
  incrementTopicTurnCount(sessionId)

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
