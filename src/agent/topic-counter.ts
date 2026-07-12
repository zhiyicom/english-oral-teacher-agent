// v1.0.2 — in-memory per-session counter tracking user turns since the
// last successful topic_select (or session start). Enforces the
// MIN_TOPIC_AGE rule so the LLM can't ping-pong between topics on
// every turn (was triggering 11 topic switches per 27-min session in
// the wild; see 2026-06-27 session ddb32b4f in data/oral-teacher.db).
//
// In-memory only — a server restart resets the counter for in-progress
// sessions. Worst case: the first post-restart turn may switch earlier
// than expected. Acceptable for a hotfix; durable storage can come
// later if needed.

const counters = new Map<string, number>()

export const DEFAULT_MIN_TOPIC_AGE = 5

function resolveMinTopicAge(): number {
  const raw = process.env.TOPIC_AGE_MIN
  if (raw === undefined) return DEFAULT_MIN_TOPIC_AGE
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MIN_TOPIC_AGE
}

export function getCurrentMinTopicAge(): number {
  return resolveMinTopicAge()
}

export function incrementTopicTurnCount(sessionId: string): number {
  const next = (counters.get(sessionId) ?? 0) + 1
  counters.set(sessionId, next)
  return next
}

export function getTopicTurnCount(sessionId: string): number {
  return counters.get(sessionId) ?? 0
}

export function resetTopicTurnCount(sessionId: string): void {
  counters.set(sessionId, 0)
}

export function deleteTopicTurnCount(sessionId: string): void {
  counters.delete(sessionId)
}

// v1.0.9 §1.4 — write-on-adoption: track the *currently active* topic per
// session so end-of-turn logic can run `isTurnOnTopic` against it. Older
// `topicTurnCount` above is unrelated (it gates topic-switch rate).
const activeTopicBySession = new Map<string, string>()

export function setActiveTopic(sessionId: string, slug: string): void {
  activeTopicBySession.set(sessionId, slug)
}

export function getActiveTopic(sessionId: string): string | null {
  return activeTopicBySession.get(sessionId) ?? null
}

export function clearActiveTopic(sessionId: string): void {
  activeTopicBySession.delete(sessionId)
}

// Detect explicit user request to switch topic — bypasses the gate.
// Patterns: "switch topic", "change topic", "new topic", "another
// topic", "fresh topic", "different topic", "换个话题", "换个新话题".
// Complaints like "stupid questions" or "asked before" do NOT bypass —
// the LLM is expected to rephrase and try a different angle first.
const EXPLICIT_SWITCH_RE =
  /\b(switch|change|new|another|fresh|different)\s+topic\b|换个?话题|换个新话题/i

export function isExplicitTopicSwitch(userInput: string): boolean {
  return EXPLICIT_SWITCH_RE.test(userInput)
}