import { describe, expect, it } from 'vitest'
import { createMockEmbedder } from '../../src/memory/embedder.js'

describe('createMockEmbedder', () => {
  it('returns a Float32Array of the default dimension (384)', async () => {
    const embedder = createMockEmbedder()
    expect(embedder.dim).toBe(384)
    const vec = await embedder.embed('hello')
    expect(vec).toBeInstanceOf(Float32Array)
    expect(vec.length).toBe(384)
  })

  it('is deterministic: same text → byte-identical vector; different text → different vector', async () => {
    const embedder = createMockEmbedder()
    const a1 = await embedder.embed('hello')
    const a2 = await embedder.embed('hello')
    const b = await embedder.embed('goodbye')
    for (let i = 0; i < a1.length; i++) {
      expect(a1[i]).toBe(a2[i])
    }
    // not all positions need differ, but at least one should
    let differs = false
    for (let i = 0; i < a1.length; i++) {
      if (a1[i] !== b[i]) {
        differs = true
        break
      }
    }
    expect(differs).toBe(true)
  })
})
