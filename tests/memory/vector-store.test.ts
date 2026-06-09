import { describe, expect, it } from 'vitest'
import { bufferToF32, cosineSimilarity, f32ToBuffer } from '../../src/memory/vector-store.js'

describe('vector-store', () => {
  describe('Float32Array ↔ Buffer roundtrip', () => {
    it('preserves all values bit-for-bit', () => {
      const original = new Float32Array([1.5, -2.25, 0, 1e-10, Math.PI])
      const buf = f32ToBuffer(original)
      const restored = bufferToF32(buf)
      expect(restored.length).toBe(original.length)
      for (let i = 0; i < original.length; i++) {
        expect(restored[i]).toBe(original[i])
      }
    })
  })

  describe('cosineSimilarity', () => {
    it('returns 1 for identical vectors', () => {
      const a = new Float32Array([1, 2, 3])
      expect(cosineSimilarity(a, a)).toBeCloseTo(1, 6)
    })

    it('returns 1 for scaled vectors (magnitude-independent)', () => {
      const a = new Float32Array([1, 2, 3])
      const b = new Float32Array([2, 4, 6])
      expect(cosineSimilarity(a, b)).toBeCloseTo(1, 6)
    })

    it('returns 0 for orthogonal vectors', () => {
      const a = new Float32Array([1, 0, 0])
      const b = new Float32Array([0, 1, 0])
      expect(cosineSimilarity(a, b)).toBeCloseTo(0, 6)
    })

    it('throws on dimension mismatch', () => {
      const a = new Float32Array([1, 2, 3])
      const b = new Float32Array([1, 2])
      expect(() => cosineSimilarity(a, b)).toThrow(/dim mismatch/)
    })
  })
})
