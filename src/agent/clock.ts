export interface Clock {
  now(): number
}

export const realClock: Clock = {
  now: () => Date.now(),
}

export interface MockClock extends Clock {
  set(t: number): void
  advance(ms: number): void
}

export function mockClock(initial: number): MockClock {
  let t = initial
  return {
    now: () => t,
    set(next: number) {
      t = next
    },
    advance(ms: number) {
      t += ms
    },
  }
}
