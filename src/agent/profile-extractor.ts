import type { LLMClient } from '../llm/types.js'

export interface StudentDiscoveries {
  newInterests: string[]
  bodyUpdate: string | null
  /**
   * v1.0.3 §1.3 — single keyword (1-3 words) picked by LLM as the next
   * session's WARM_UP opener hook. Server caches this in module-scoped
   * `pendingWarmUpSeed` and injects it into the first-turn WARM_UP hint
   * so the LLM has a focused direction instead of pure improv. Null when
   * no suitable opener exists.
   */
  nextWarmUpSeed: string | null
}

const EXTRACTION_PROMPT = [
  'You are a student profile updater. Given a session summary, identify NEW factual',
  'information about the student that should be added to their profile.',
  '',
  'Return ONLY a JSON object (no markdown, no explanation):',
  '{',
  '  "new_interests": ["cello", "rock music"],',
  '  "body_update": "Student has been playing cello for 8 years and also plays piano. They enjoy orchestral performance.",',
  '  "next_warm_up_seed": "cello"',
  '}',
  '',
  'Rules:',
  '- Only include CONCRETE new facts (skills, instruments, achievements, preferences)',
  '- Do NOT include transient events ("did homework yesterday", "ate pizza today")',
  '- If the student mentions a long-term hobby or skill, capture it',
  '- body_update should be 1-3 factual sentences in English',
  '- next_warm_up_seed: ONE short keyword (1-3 words) from this session that would',
  '  make a natural, friendly opener for the NEXT session. Prefer something',
  '  light/social (e.g. a hobby, place, food, daily activity), not a heavy topic.',
  '  Pick from the keywords above if any fits; otherwise pick any concrete noun',
  '  from the summary. Return null if nothing suitable.',
  '- If nothing new, return {"new_interests": [], "body_update": null, "next_warm_up_seed": null}',
].join('\n')

export async function extractStudentDiscoveries(
  summary: string,
  existingInterests: string[],
  client: LLMClient,
): Promise<StudentDiscoveries> {
  const interestsHint =
    existingInterests.length > 0
      ? `\nCurrent known interests: ${existingInterests.join(', ')}\n`
      : ''

  const prompt = `${EXTRACTION_PROMPT}${interestsHint}\nSession summary: ${summary}`

  const result = await client.chat({
    system: 'You extract structured student profile updates. Always output valid JSON.',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.3,
    maxTokens: 300,
  })

  try {
    const parsed = JSON.parse(result.content)
    const seed = typeof parsed.next_warm_up_seed === 'string' ? parsed.next_warm_up_seed.trim() : ''
    return {
      newInterests: Array.isArray(parsed.new_interests) ? parsed.new_interests : [],
      bodyUpdate: typeof parsed.body_update === 'string' ? parsed.body_update : null,
      nextWarmUpSeed: seed.length > 0 ? seed : null,
    }
  } catch {
    return { newInterests: [], bodyUpdate: null, nextWarmUpSeed: null }
  }
}
