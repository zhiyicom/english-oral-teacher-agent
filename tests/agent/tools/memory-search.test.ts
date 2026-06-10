import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  MemorySearchArgsSchema,
  createMemorySearchTool,
} from '../../../src/agent/tools/memory-search.js'
import type { Embedder } from '../../../src/memory/embedder.js'
import { applyMigrations, openDb } from '../../../src/storage/db.js'
import { createSessionsDao } from '../../../src/storage/sessions.js'
import { resolveMigrationsDirForTesting } from '../../storage/helpers.js'

const migrationsDir = resolveMigrationsDirForTesting()
const DIM = 384

/**
 * Stub embedder that returns a fixed vector per query string. Lets us
 * control cosine similarity between query and pre-seeded session
 * embeddings without loading the real transformers.js pipeline.
 *
 * "minecraft" → 1.0 in dim 0 (everything else 0)
 * "cooking"   → 1.0 in dim 1
 * anything else → 0.5 in dim 0 (weak match for minecraft, 0 for cooking)
 */
function makeStubEmbedder(): Embedder {
  const vecFor = (s: string): Float32Array => {
    const v = new Float32Array(DIM)
    if (s === 'minecraft') {
      v[0] = 1
    } else if (s === 'cooking') {
      v[1] = 1
    } else {
      v[0] = 0.5
    }
    return v
  }
  return {
    dim: DIM,
    async embed(s: string): Promise<Float32Array> {
      return vecFor(s)
    },
  }
}

describe('memory_search tool (v0.7.3 L1)', () => {
  let dir: string
  let db: ReturnType<typeof openDb>
  let embedder: Embedder

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tool-memory-search-test-'))
    db = openDb({ dataDir: dir })
    applyMigrations(db, migrationsDir)
    embedder = makeStubEmbedder()
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  describe('schema', () => {
    it('accepts a well-formed args object (query + top_k)', () => {
      const ok = MemorySearchArgsSchema.safeParse({ query: 'minecraft', top_k: 3 })
      expect(ok.success).toBe(true)
    })

    it('rejects missing query (empty args)', () => {
      const bad = MemorySearchArgsSchema.safeParse({})
      expect(bad.success).toBe(false)
    })

    it('defaults top_k to 2 when omitted', () => {
      const ok = MemorySearchArgsSchema.safeParse({ query: 'minecraft' })
      expect(ok.success).toBe(true)
      if (ok.success) {
        expect(ok.data.top_k).toBe(2)
      }
    })

    it('rejects top_k > 5 (upper bound)', () => {
      const bad = MemorySearchArgsSchema.safeParse({ query: 'x', top_k: 10 })
      expect(bad.success).toBe(false)
    })

    it('rejects query longer than 200 chars', () => {
      const tooLong = 'a'.repeat(201)
      const bad = MemorySearchArgsSchema.safeParse({ query: tooLong, top_k: 2 })
      expect(bad.success).toBe(false)
    })
  })

  describe('execute', () => {
    it('returns [] when no sessions have embeddings', async () => {
      const tool = createMemorySearchTool(db, embedder)
      // No seed sessions; DB empty
      const result = await tool.execute({ query: 'minecraft', top_k: 2 })
      expect(result).toEqual([])
    })

    it('ranks the most similar session first across multiple candidates', async () => {
      const sessions = createSessionsDao(db)
      // Pre-seed 2 sessions with summaries + embeddings
      const a = sessions.create()
      sessions.markEnded(a.id, {
        summary: 'Student talked about Minecraft castle and creeper',
        keywords: ['minecraft', 'castle', 'creeper'],
        reason: 'user_exit',
        phaseHistory: [],
      })
      sessions.setEmbedding(a.id, await embedder.embed('minecraft'))
      const b = sessions.create()
      sessions.markEnded(b.id, {
        summary: 'Student talked about cooking pasta carbonara',
        keywords: ['cooking', 'pasta', 'carbonara'],
        reason: 'user_exit',
        phaseHistory: [],
      })
      sessions.setEmbedding(b.id, await embedder.embed('cooking'))

      const tool = createMemorySearchTool(db, embedder)
      // top_k=2 returns both; minecraft must be ranked first (cosine=1.0 vs
      // cooking=0.0 — orthogonal vectors in distinct dims). We don't assert
      // an empty result for the cooking session because retrieveRelevant
      // has no similarity floor — that's the caller's job (or v0.7.2
      // startup-injection's job, which uses topK=2 and accepts the noise).
      const result = await tool.execute({ query: 'minecraft', top_k: 2 })
      expect(result).toHaveLength(2)
      expect(result[0]?.sessionId).toBe(a.id)
      expect(result[0]?.similarity).toBeCloseTo(1, 5)
      expect(result[0]?.keywords).toContain('minecraft')
      expect(result[1]?.sessionId).toBe(b.id)
      expect(result[1]?.similarity).toBeCloseTo(0, 5)
    })

    it('throws zod error when args are invalid — caller wraps in try/catch', async () => {
      const tool = createMemorySearchTool(db, embedder)
      await expect(tool.execute({})).rejects.toBeInstanceOf(z.ZodError)
    })

    it('exposes name="memory_search" and a non-empty description', () => {
      const tool = createMemorySearchTool(db, embedder)
      expect(tool.name).toBe('memory_search')
      expect(tool.description.length).toBeGreaterThan(10)
    })
  })
})
