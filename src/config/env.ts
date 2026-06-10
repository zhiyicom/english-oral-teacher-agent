import 'dotenv/config'
import { z } from 'zod'

const EnvSchema = z.object({
  LLM_PROVIDER: z.enum(['minimax']).default('minimax'),
  MINIMAX_API_KEY: z.string().min(1, 'MINIMAX_API_KEY is required'),
  ANTHROPIC_BASE_URL: z.string().url().default('https://api.minimaxi.com/anthropic'),
  LLM_MODEL_MAIN: z.string().default('MiniMax-M3'),
  LLM_MODEL_SUMMARIZER: z.string().default('MiniMax-M3'),
  LLM_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.7),
  LLM_MAX_TOKENS: z.coerce.number().int().positive().default(2048),
  // v0.7.5 — single-turn input token cap. CLI truncates oldest history
  // (sliding window) when the estimated input exceeds this. Default 6000
  // per PRD §5.3; range 1..200_000. Per-session warn fires at 80%.
  LLM_CONTEXT_BUDGET_TOKENS: z.coerce.number().int().min(1).max(200000).default(6000),
  APP_DATA_DIR: z.string().default('./data'),
  APP_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  RUN_LIVE_LLM: z.enum(['0', '1']).optional(),
})

export type Env = z.infer<typeof EnvSchema>

export function loadEnv(): Env {
  const result = EnvSchema.safeParse(process.env)
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n')
    throw new Error(`Invalid environment:\n${issues}`)
  }
  return result.data
}
