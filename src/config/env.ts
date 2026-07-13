import 'dotenv/config'
import { join } from 'node:path'
import { z } from 'zod'
import { getAppDataDir } from './paths.js'
import { readEnvFile } from './secrets.js'

const EnvSchema = z.object({
  // v1.0.8 §1.7 — LLM wire format. 'anthropic' uses @anthropic-ai/sdk with
  // x-api-key header and /v1/messages path; 'openai' uses fetch with
  // Authorization: Bearer and /chat/completions (DeepSeek / OpenAI / OpenRouter).
  // Default 'anthropic' keeps v1.0.7 behavior intact.
  API_STYLE: z.enum(['anthropic', 'openai']).default('anthropic'),
  // v1.0.6 §1.6 — API_KEY is now optional at zod parse time. Actual
  // resolution happens via getApiKey() (secrets.ts) with AppData/.env +
  // cwd/.env fallback. If getApiKey() returns null, the server starts in
  // "setup needed" mode and the web UI shows /setup.
  API_KEY: z.string().optional(),
  ANTHROPIC_BASE_URL: z.string().url().default('https://api.minimaxi.com/anthropic'),
  LLM_MODEL: z.string().default('MiniMax-M3'),
  LLM_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.7),
  LLM_MAX_TOKENS: z.coerce.number().int().positive().default(2048),
  // v0.7.5 — single-turn input token cap. CLI truncates oldest history
  // (sliding window) when the estimated input exceeds this. Default 6000
  // per PRD §5.3; range 1..200_000. Per-session warn fires at 80%.
  LLM_CONTEXT_BUDGET_TOKENS: z.coerce.number().int().min(1).max(200000).default(6000),
  // v0.8.1 — HTTP server listen port for src/server.ts. Default 3000.
  // Range 1..65535. CLI ignores this (it doesn't bind a port).
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  // v1.0.5.2 §1.2 — APP_DATA_DIR is now optional. src/config/paths.ts
  // picks a platform default (or honors an explicit override). Legacy
  // ./data is auto-detected with a one-time warning.
  APP_DATA_DIR: z.string().optional(),
  APP_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  RUN_LIVE_LLM: z.enum(['0', '1']).optional(),
  DEBUG_LOG_LLM: z.enum(['0', '1']).optional(),
})

export type Env = z.infer<typeof EnvSchema>

export function loadEnv(): Env {
  // Build input by merging env files into process.env.
  // Priority: process.env > AppData/.env > CWD/.env > schema defaults.
  // This matches getEnvVar() / getApiKey() so Web UI settings persist across
  // restarts even when the install directory has no .env file.
  const input: Record<string, string | undefined> = {}
  // 1. CWD/.env (dotenv/config already loaded it into process.env)
  // 2. AppData/.env (Web UI writes here; lower priority than process.env)
  for (const path of [
    join(getAppDataDir(), '.env'),
    join(process.cwd(), '.env'),
  ]) {
    const file = readEnvFile(path)
    for (const [k, v] of Object.entries(file)) {
      if (!(k in input)) input[k] = v
    }
  }
  // 3. process.env (highest priority)
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) input[k] = v
  }

  const result = EnvSchema.safeParse(input)
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n')
    throw new Error(`Invalid environment:\n${issues}`)
  }
  return result.data
}
