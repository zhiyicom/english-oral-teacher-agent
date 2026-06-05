import { describe, expect, it } from 'vitest'
import { mockClock, realClock } from '../../src/agent/clock.js'

describe('Clock', () => {
  it('realClock.now() is within 100ms of Date.now()', () => {
    const a = realClock.now()
    const b = Date.now()
    expect(Math.abs(a - b)).toBeLessThan(100)
  })

  it('mockClock(initial) returns initial from now()', () => {
    const c = mockClock(1000)
    expect(c.now()).toBe(1000)
    expect(c.now()).toBe(1000)
  })

  it('mockClock.set(n) jumps to new value', () => {
    const c = mockClock(1000)
    c.set(5000)
    expect(c.now()).toBe(5000)
  })

  it('mockClock.advance(ms) moves forward by ms', () => {
    const c = mockClock(1000)
    c.advance(60_000)
    expect(c.now()).toBe(61_000)
    c.advance(500)
    expect(c.now()).toBe(61_500)
  })
})
