/**
 * Text → vector embedder. v0.7.2.
 *
 * Two implementations:
 *  - createTransformersEmbedder: real @huggingface/transformers, MiniLM-L6-v2 int8.
 *    Lazy-loaded at first embed() call (~30-40s first time downloads model from
 *    HuggingFace; cached to ~/.cache/huggingface/ thereafter). Set HF_ENDPOINT
 *    env var to use a mirror (e.g. https://hf-mirror.com for China network).
 *  - createMockEmbedder: deterministic synthetic vectors for L1 tests, so we
 *    don't have to load the real model in every test run.
 */

export interface Embedder {
  embed(text: string): Promise<Float32Array>
  /** Vector dimension (e.g. 384 for MiniLM-L6-v2). */
  readonly dim: number
}

const DEFAULT_DIM = 384
const DEFAULT_MODEL = 'Xenova/all-MiniLM-L6-v2'

// Module-level singleton: pipeline is shared across all embedder instances in
// the same process. null = not yet loaded; first embed() triggers async load.
// biome-ignore lint/suspicious/noExplicitAny: pipeline type lives in transformers lib
let extractorPromise: Promise<any> | null = null

async function getExtractor(): Promise<unknown> {
  if (!extractorPromise) {
    const { env, pipeline } = await import('@huggingface/transformers')
    // Honor HF_ENDPOINT if set (China mirror, custom registry, etc.)
    const endpoint = process.env.HF_ENDPOINT
    if (endpoint) {
      env.remoteHost = endpoint
    }
    extractorPromise = pipeline('feature-extraction', DEFAULT_MODEL, {
      dtype: 'q8',
    })
  }
  return extractorPromise
}

export function createTransformersEmbedder(): Embedder {
  return {
    dim: DEFAULT_DIM,
    async embed(text: string): Promise<Float32Array> {
      const extractor = (await getExtractor()) as (
        input: string,
        opts: { pooling: 'mean'; normalize: boolean },
      ) => Promise<{ data: Float32Array | number[] }>
      const out = await extractor(text, { pooling: 'mean', normalize: true })
      // out.data may be Float32Array or number[] depending on backend
      return out.data instanceof Float32Array ? out.data : new Float32Array(out.data)
    },
  }
}

export function createMockEmbedder(
  opts: {
    table?: Record<string, Float32Array>
    dim?: number
  } = {},
): Embedder {
  const dim = opts.dim ?? DEFAULT_DIM
  const table = opts.table ?? {}
  return {
    dim,
    async embed(text: string): Promise<Float32Array> {
      const fromTable = table[text]
      if (fromTable) return new Float32Array(fromTable)
      // Default: derive a deterministic vector from text codepoints.
      const seed = [...text].reduce((s, c) => s + c.charCodeAt(0), 0)
      const vec = new Float32Array(dim)
      for (let i = 0; i < dim; i++) {
        vec[i] = Math.sin(seed + i)
      }
      return vec
    },
  }
}
