/**
 * Float32Array ↔ Buffer serialization + cosine similarity. v0.7.2.
 *
 * BLOB layout in SQLite: raw bytes of a Float32Array's underlying ArrayBuffer.
 * Endianness is V8 native (little-endian on x64 — every supported platform).
 * If we ever support ARM, switch read/write to DataView.getFloat32(i, true).
 *
 * cosineSimilarity is brute-force, called once per candidate at retrieval time.
 * At 1000 sessions × 384 dim that's ~384K mul-add ops = sub-millisecond on any
 * modern laptop — no need for SIMD or worker threads.
 */

/** Float32Array → Buffer (zero-copy view over the same ArrayBuffer). */
export function f32ToBuffer(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength)
}

/**
 * Buffer → Float32Array. Copies into a fresh ArrayBuffer because better-sqlite3
 * does not guarantee the returned Buffer outlives the next prepared-statement
 * step; reading directly into a view over it can produce dangling data.
 */
export function bufferToF32(buf: Buffer): Float32Array {
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  return new Float32Array(ab)
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`cosineSimilarity: dim mismatch ${a.length} vs ${b.length}`)
  }
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number
    const y = b[i] as number
    dot += x * y
    na += x * x
    nb += y * y
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  if (denom === 0) return 0
  return dot / denom
}
