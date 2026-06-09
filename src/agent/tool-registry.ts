import type { z } from 'zod'

/**
 * A tool the LLM can call by emitting `<tool>name({...args})</tool>` text.
 *
 * - `name` is the bare identifier the LLM writes.
 * - `description` is what we paste into the system prompt for that tool.
 * - `schema` validates `args` before `execute` runs.
 * - `execute` performs a synchronous side-effect (e.g. DB write) and returns
 *   any value. Whether/how the LLM sees the return value is the caller's
 *   choice — in v0.7 nothing is fed back to the LLM (sync side-effect tool).
 */
export interface Tool {
  readonly name: string
  readonly description: string
  readonly schema: z.ZodTypeAny
  execute(args: unknown): unknown
}

export interface ToolRegistry {
  register(tool: Tool): void
  get(name: string): Tool | undefined
  list(): Tool[]
}

export function createToolRegistry(): ToolRegistry {
  const tools = new Map<string, Tool>()
  return {
    register(tool) {
      if (tools.has(tool.name)) {
        throw new Error(`Tool already registered: ${tool.name}`)
      }
      tools.set(tool.name, tool)
    },
    get(name) {
      return tools.get(name)
    },
    list() {
      return [...tools.values()]
    },
  }
}
