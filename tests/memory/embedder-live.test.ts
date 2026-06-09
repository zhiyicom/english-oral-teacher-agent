/**
 * L2 — Real transformers.js embedder. First run downloads the model
 * (~25MB, can take ~30-60s on slow networks). Subsequent runs read from
 * the local HF cache and complete in 2-4s.
 *
 * Set HF_ENDPOINT=https://hf-mirror.com if the default HuggingFace host is
 * unreachable from your network (the embedder honors this env var per
 * src/memory/embedder.ts).
 */

import { describe, expect, it } from 'vitest'
import { createTransformersEmbedder } from '../../src/memory/embedder.js'

describe('Embedder (L2 — real transformers.js)', () => {
  it('produces 384-dim Float32Array and is deterministic for same input', async () => {
    const embedder = createTransformersEmbedder()
    const a = await embedder.embed('hello world')
    const b = await embedder.embed('hello world')

    expect(a).toBeInstanceOf(Float32Array)
    expect(a.length).toBe(384)
    expect(b.length).toBe(384)
    // L2-normalized mean-pooled output is fully deterministic for the same
    // input on the same model — byte-identical, not just close.
    for (let i = 0; i < a.length; i++) {
      expect(a[i]).toBe(b[i])
    }

    // And different input → at least one position differs (sanity check
    // that we're not returning a constant vector for everything).
    const c = await embedder.embed('completely different text here')
    let differs = false
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== c[i]) {
        differs = true
        break
      }
    }
    expect(differs).toBe(true)
  }, 180_000)
})
