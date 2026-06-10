import type { z } from 'zod'

/**
 * A tool the LLM can call by emitting `<tool>name({...args})</tool>` text.
 *
 * - `name` is the bare identifier the LLM writes.
 * - `description` is what we paste into the system prompt for that tool.
 * - `schema` validates `args` before `execute` runs.
 * - `execute` runs the tool and returns its result. The return type is
 *   `Promise<unknown> | unknown` to admit both sync side-effect tools
 *   (v0.7 `mark_mistake` — DB write, no feedback) and async information
 *   retrieval tools (v0.7.3 `memory_search` — embed + DB read, result
 *   fed back to the LLM via the A+B hybrid protocol in cli.ts). Callers
 *   that need the return value can `await` it; awaiting a non-Promise
 *   just resolves to the value, so sync tools are unaffected.
 */
export interface Tool {
  readonly name: string
  readonly description: string
  readonly schema: z.ZodTypeAny
  execute(args: unknown): Promise<unknown> | unknown
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
