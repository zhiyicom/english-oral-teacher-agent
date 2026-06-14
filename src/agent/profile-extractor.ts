import type { LLMClient } from '../llm/types.js'

export interface StudentDiscoveries {
  newInterests: string[]
  bodyUpdate: string | null
}

const EXTRACTION_PROMPT = [
  'You are a student profile updater. Given a session summary, identify NEW factual',
  'information about the student that should be added to their profile.',
  '',
  'Return ONLY a JSON object (no markdown, no explanation):',
  '{',
  '  "new_interests": ["cello", "rock music"],',
  '  "body_update": "Student has been playing cello for 8 years and also plays piano. They enjoy orchestral performance."',
  '}',
  '',
  'Rules:',
  '- Only include CONCRETE new facts (skills, instruments, achievements, preferences)',
  '- Do NOT include transient events ("did homework yesterday", "ate pizza today")',
  '- If the student mentions a long-term hobby or skill, capture it',
  '- body_update should be 1-3 factual sentences in English',
  '- If nothing new, return {"new_interests": [], "body_update": null}',
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
    return {
      newInterests: Array.isArray(parsed.new_interests) ? parsed.new_interests : [],
      bodyUpdate: typeof parsed.body_update === 'string' ? parsed.body_update : null,
    }
  } catch {
    return { newInterests: [], bodyUpdate: null }
  }
}
