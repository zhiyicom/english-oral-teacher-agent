import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { type Tool, createToolRegistry } from '../../src/agent/tool-registry.js'

function makeStubTool(name: string, fn: (args: unknown) => unknown = () => undefined): Tool {
  return {
    name,
    description: `stub tool ${name}`,
    schema: z.object({}).passthrough(),
    execute: fn,
  }
}

describe('ToolRegistry (v0.7 L1)', () => {
  it('register + get round-trips a tool by name', () => {
    const reg = createToolRegistry()
    const t = makeStubTool('mark_mistake')
    reg.register(t)
    expect(reg.get('mark_mistake')).toBe(t)
  })

  it('get returns undefined for an unknown tool', () => {
    const reg = createToolRegistry()
    expect(reg.get('nope')).toBeUndefined()
  })

  it('list returns all registered tools (insertion order)', () => {
    const reg = createToolRegistry()
    reg.register(makeStubTool('a'))
    reg.register(makeStubTool('b'))
    reg.register(makeStubTool('c'))
    expect(reg.list().map((t) => t.name)).toEqual(['a', 'b', 'c'])
  })

  it('register throws on duplicate name (fail fast — no silent overwrite)', () => {
    const reg = createToolRegistry()
    reg.register(makeStubTool('mark_mistake'))
    expect(() => reg.register(makeStubTool('mark_mistake'))).toThrow(/already registered/i)
  })

  it('list on an empty registry is an empty array (not undefined)', () => {
    const reg = createToolRegistry()
    expect(reg.list()).toEqual([])
  })
})
