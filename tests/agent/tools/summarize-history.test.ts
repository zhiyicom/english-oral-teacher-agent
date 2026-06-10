import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  SummarizeHistoryArgsSchema,
  createSummarizeHistoryTool,
} from '../../../src/agent/tools/summarize-history.js'

describe('summarize_history tool (v0.7.6 B2 L1)', () => {
  describe('schema', () => {
    it('accepts a well-formed args object', () => {
      const ok = SummarizeHistoryArgsSchema.safeParse({ target_tokens: 500 })
      expect(ok.success).toBe(true)
    })

    it('defaults target_tokens to 500 when omitted', () => {
      const ok = SummarizeHistoryArgsSchema.safeParse({})
      expect(ok.success).toBe(true)
      if (ok.success) {
        expect(ok.data.target_tokens).toBe(500)
      }
    })

    it('rejects target_tokens below the lower bound (< 100)', () => {
      const bad = SummarizeHistoryArgsSchema.safeParse({ target_tokens: 50 })
      expect(bad.success).toBe(false)
    })

    it('rejects target_tokens above the upper bound (> 3000)', () => {
      const bad = SummarizeHistoryArgsSchema.safeParse({ target_tokens: 5000 })
      expect(bad.success).toBe(false)
    })

    it('rejects non-integer target_tokens', () => {
      const bad = SummarizeHistoryArgsSchema.safeParse({ target_tokens: 500.5 })
      expect(bad.success).toBe(false)
    })
  })

  describe('execute', () => {
    it('returns a typed signal { kind, targetTokens } that the CLI matches on', async () => {
      const tool = createSummarizeHistoryTool()
      const result = await tool.execute({ target_tokens: 800 })
      expect(result).toEqual({ kind: 'summarize_history', targetTokens: 800 })
    })

    it('throws zod error when args are invalid', async () => {
      const tool = createSummarizeHistoryTool()
      await expect(tool.execute({ target_tokens: 0 })).rejects.toBeInstanceOf(z.ZodError)
    })

    it('exposes name="summarize_history" and a non-empty description', () => {
      const tool = createSummarizeHistoryTool()
      expect(tool.name).toBe('summarize_history')
      expect(tool.description.length).toBeGreaterThan(10)
    })

    it('description tells the LLM not to call another tool in the 2nd response', () => {
      const tool = createSummarizeHistoryTool()
      expect(tool.description.toLowerCase()).toContain('do not call any tool')
    })
  })
})
