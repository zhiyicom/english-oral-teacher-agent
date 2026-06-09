import { z } from 'zod'
import type { DbHandle } from '../../storage/db.js'
import { createMistakesDao } from '../../storage/mistakes.js'
import type { Tool } from '../tool-registry.js'

export const MarkMistakeArgsSchema = z.object({
  original: z.string().min(1).max(500),
  corrected: z.string().min(1).max(500),
  category: z.enum(['grammar', 'vocabulary', 'spelling']),
})

export type MarkMistakeArgs = z.infer<typeof MarkMistakeArgsSchema>

const DESCRIPTION =
  'Record a mistake the student just made. Use when the student says ' +
  'something ungrammatical, uses the wrong word, or misspells.'

/**
 * Factory that binds the tool to a session row at CLI startup.
 *
 * The LLM doesn't see `sessionId` — it's injected here so the schema stays
 * clean and the tool never crosses sessions by accident.
 */
export function createMarkMistakeTool(db: DbHandle, sessionId: string): Tool {
  const mistakes = createMistakesDao(db)
  return {
    name: 'mark_mistake',
    description: DESCRIPTION,
    schema: MarkMistakeArgsSchema,
    execute(args: unknown) {
      const parsed = MarkMistakeArgsSchema.parse(args)
      return mistakes.append({
        sessionId,
        original: parsed.original,
        corrected: parsed.corrected,
        category: parsed.category,
      })
    },
  }
}
