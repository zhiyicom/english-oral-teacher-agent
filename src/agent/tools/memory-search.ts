import { z } from 'zod'
import type { Embedder } from '../../memory/embedder.js'
import type { RelevantSession } from '../../memory/retrieve-relevant.js'
import { retrieveRelevant } from '../../memory/retrieve-relevant.js'
import type { DbHandle } from '../../storage/db.js'
import { createSessionsDao } from '../../storage/sessions.js'
import type { Tool } from '../tool-registry.js'

/**
 * `memory_search` tool. v0.7.3.
 *
 * LLM-driven cross-session semantic retrieval. Unlike the v0.7.2 startup
 * injection (which uses lastReview.keywords as the query and is first-turn
 * only), this tool lets the LLM fire a query mid-conversation when the
 * student references something that might be in a past session.
 *
 * Protocol: A+B hybrid (see v0.7.3-design.md §2). The CLI captures the
 * result, feeds it back to the LLM as a synthetic user message, and
 * makes a 2nd LLM call. So this tool is `async` (embed is async) and
 * the `Tool` interface had to be widened to allow `Promise<unknown>`.
 */

export const MemorySearchArgsSchema = z.object({
  query: z.string().min(1).max(200),
  top_k: z.number().int().min(1).max(5).default(2),
})

export type MemorySearchArgs = z.infer<typeof MemorySearchArgsSchema>

const DESCRIPTION =
  'Search past sessions by semantic similarity to a query. ' +
  'Returns up to top_k sessions (most similar first), each with date, ' +
  'summary (truncated to 80 chars), and keywords. ' +
  'Use when the student references something that might be in a past session.'

/**
 * Factory that binds the tool to the embedder + DB at CLI startup.
 *
 * - `embedder` is the same singleton instance as v0.7.2 startup retrieval
 *   (pipeline singleton shared across embed() calls). The first call here
 *   will be the first embed() in the process, so it pays the model load cost
 *   (~1-2s if model already cached, ~30-40s first time ever).
 * - `db` is shared with all other DAOs.
 *
 * The LLM never sees `db` or `embedder` — both are injected.
 */
export function createMemorySearchTool(db: DbHandle, embedder: Embedder): Tool {
  const sessions = createSessionsDao(db)
  return {
    name: 'memory_search',
    description: DESCRIPTION,
    schema: MemorySearchArgsSchema,
    async execute(args: unknown): Promise<RelevantSession[]> {
      const parsed = MemorySearchArgsSchema.parse(args)
      const queryVec = await embedder.embed(parsed.query)
      const candidates = sessions.listWithEmbeddings()
      return retrieveRelevant({
        candidates,
        queryVec,
        topK: parsed.top_k,
      })
    },
  }
}
