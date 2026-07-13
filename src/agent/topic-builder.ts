// src/agent/topic-builder.ts
// v1.1.0 §1.4 — LLM-curated topic creation for the auto-expand pipeline.
// Given a list of session keywords that didn't match any existing topic,
// ask the LLM whether they describe a coherent new topic. The user-
// facing policy (per the v1.1.0 design doc) is to **prefer declining**
// over creating noise — `should_create: false` should dominate when the
// LLM is uncertain. The pure-JS validation chain below enforces
// additional safety: any malformed/duplicate/incomplete proposal is
// rejected before we ever touch the DAO.

import type { LLMClient } from '../llm/types.js'

export interface ProposedTopic {
  name: string
  keywords: string[]
  description: string
}

const SLUG_REGEX = /^[a-z][a-z0-9_]{2,29}$/
const MAX_KEYWORDS = 15
const MAX_DESCRIPTION = 200
// Strictly greater than this. 2-char tokens like "ok" / "hi" / "us"
// are interjections with no topic-discriminating power, so the prompt's
// "drop noise (1-2 char words)" rule is enforced locally too.
const MIN_KEYWORD_LENGTH = 2

const TOPIC_BUILDER_PROMPT = [
  'You are a topic taxonomy builder for an English oral-teacher agent.',
  'Given a list of keywords that did NOT match any existing topic, decide',
  'whether they describe a coherent new topic worth adding to the library.',
  '',
  'Return ONLY a JSON object (no markdown, no explanation):',
  '{',
  '  "should_create": true | false,',
  '  "name": "topic_slug_snake_case",',
  '  "keywords": ["keyword1", "keyword2", ...],',
  '  "description": "Short English label (B1/B2 hint)"',
  '}',
  '',
  'Rules:',
  '- When in doubt, return should_create: false (we can re-evaluate next session).',
  '- Only create when keywords describe a coherent topic (>=2 keywords, each >=2 chars).',
  '- Reject scattered / 1-word trivia / transient events (e.g. "ok", "yes", "really").',
  '- Slug: 3-30 chars, lowercase, snake_case, English-only, must be unique vs existing.',
  '- keywords: 3-15 English lowercase tokens. Include meaningful original inputs;',
  '  drop noise (1-2 char words, pure numbers, interjections).',
  '- description: 1 short English sentence with B1/B2 level hint (max 200 chars).',
].join('\n')

/**
 * Ask the LLM to propose a new topic for unmatched keywords.
 *
 * Returns `null` for any of the failure modes (decline, parse error,
 * schema violation, duplicate name, insufficient keywords). The caller
 * treats `null` as "skip this round"; the auto-expand pipeline does not
 * surface failures to the user.
 */
export async function extractNewTopicFromKeywords(
  keywords: string[],
  existingTopicNames: readonly string[],
  client: LLMClient,
): Promise<ProposedTopic | null> {
  if (keywords.length === 0) return null

  const prompt =
    `${TOPIC_BUILDER_PROMPT}\n\n` +
    `Existing topic names (DO NOT reuse): ${existingTopicNames.join(', ')}\n\n` +
    `Keywords to evaluate: ${keywords.join(', ')}\n\n` +
    `Return ONLY the JSON object.`

  let parsed: unknown
  try {
    const result = await client.chat({
      system: 'You build structured topic taxonomy. Always output valid JSON.',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      maxTokens: 250,
    })
    parsed = JSON.parse(result.content)
  } catch {
    // Parse failure or transport error — treat as decline. The outer
    // auto-expand try/catch also catches thrown errors, but failing here
    // keeps the function's contract simple: returns null on any failure.
    return null
  }

  if (!isObject(parsed)) return null
  if (parsed.should_create !== true) return null

  const name = parsed.name
  if (typeof name !== 'string' || !SLUG_REGEX.test(name)) return null
  if (existingTopicNames.includes(name)) return null

  if (!Array.isArray(parsed.keywords)) return null
  const kwClean = parsed.keywords
    .filter((k): k is string => typeof k === 'string')
    .map((k) => k.toLowerCase().trim())
    .filter((k) => k.length > MIN_KEYWORD_LENGTH && !/^\d+$/.test(k))
    .slice(0, MAX_KEYWORDS)
  if (kwClean.length < 2) return null

  if (typeof parsed.description !== 'string') return null
  const descClean = parsed.description.trim()
  if (descClean.length === 0 || descClean.length > MAX_DESCRIPTION) return null

  return { name, keywords: kwClean, description: descClean }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
