#!/usr/bin/env node
// scripts/live-validate-v0.7.5.mjs
// Sprint v0.7.5 — live LLM smoke for context budget enforcement (truncation
// + usage log + 80% warn + prompt cache hit).
//
// Runs 2 scenarios serially, each spawning 1 CLI child process against the
// real MiniMax-M3 endpoint. Captures stdout/stderr to
// data/live-validation/<ts>/. Verdict (pass/fail) is human-judged from
// transcripts and written to docs/sprint/v0.7.5-validation-report.md.
//
// DoD #6 expectations (per v0.7.5-scope §5):
//   - scenario 1 (verbose 30+ turn, budget=3000): stderr has
//     "[cli] truncated: dropped N pairs..." at least once
//   - scenario 1: stderr has "[cli] warn: context usage X% (budget=Y)"
//     at least once
//   - scenario 1: after turn 2, "[cli] tokens: ... cache_read=NN>0"
//     appears (Anthropic prompt cache hit on the static SOUL+AGENTS+USER
//     prefix)
//   - scenario 2 (default budget, 4 turns): no truncation, no warn;
//     verify "happy path" still works (regression check for v0.7.3 flow)
//
// Requires:
//   - MINIMAX_API_KEY in env (NOT read from .env — operator provides)
//   - node_modules installed (tsx is a dev dep)
//   - Network access to ANTHROPIC_BASE_URL + HF_ENDPOINT (default mirror)
//
// This script does NOT make any product code changes. It is a dev tool.

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const ROOT = resolve(__filename, '..', '..')

// ---------- Pre-flight ----------

if (!process.env.MINIMAX_API_KEY) {
  console.error('[live-validate] MINIMAX_API_KEY is not set.')
  console.error('  Run as:  MINIMAX_API_KEY=sk-... node scripts/live-validate-v0.7.5.mjs')
  process.exit(1)
}
if (!existsSync(resolve(ROOT, 'node_modules', 'tsx'))) {
  console.error('[live-validate] node_modules/tsx not found. Run `pnpm install` first.')
  process.exit(1)
}

const MODEL = process.env.LLM_MODEL_MAIN ?? 'MiniMax-M3'
const HF_ENDPOINT = process.env.HF_ENDPOINT ?? 'https://hf-mirror.com'

// ---------- Output dir ----------

const ts = new Date().toISOString().replace(/[:.]/g, '-')
const outRoot = resolve(ROOT, 'data', 'live-validation', ts)
mkdirSync(outRoot, { recursive: true })

console.log(`[live-validate] model:        ${MODEL}`)
console.log(`[live-validate] HF_ENDPOINT:  ${HF_ENDPOINT}`)
console.log(`[live-validate] output root:  ${outRoot}`)
console.log(`[live-validate] starting at:  ${new Date().toISOString()}\n`)

// ---------- Per-process runner ----------

/**
 * Spawn one CLI child process, feed it inputs at fixed intervals, collect
 * stdout/stderr until the child closes (or until timeoutMs elapses).
 *
 * @param {object} opts
 * @param {string} opts.label            human label for logs
 * @param {string} opts.dataDir          APP_DATA_DIR
 * @param {string[]} opts.inputs         lines to write to stdin
 * @param {Record<string,string>} [opts.extraEnv]  extra env vars (e.g. budget override)
 * @param {number} [opts.timeoutMs]      hard timeout
 * @param {number} [opts.inputSpacingMs] delay between input lines
 * @param {number} [opts.startupDelayMs] delay before the FIRST input
 * @returns {Promise<{code: number|null, stdout: string, stderr: string}>}
 */
function runProcess(opts) {
  const {
    label,
    dataDir,
    inputs,
    extraEnv = {},
    timeoutMs = 180_000,
    inputSpacingMs = 3000,
    startupDelayMs = 1000,
  } = opts

  return new Promise((res) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', resolve(ROOT, 'src', 'cli.ts')],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          APP_DATA_DIR: dataDir,
          HF_ENDPOINT,
          ...extraEnv,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => {
      stdout += d.toString()
    })
    child.stderr.on('data', (d) => {
      stderr += d.toString()
    })

    // Stdin writer — write inputs with spacing, end stdin after the last
    let i = 0
    const writeNext = () => {
      if (i >= inputs.length) {
        // Brief tail to let the CLI process the final "exit" cleanly
        setTimeout(() => child.stdin.end(), 1500)
        return
      }
      child.stdin.write(`${inputs[i]}\n`)
      i += 1
      setTimeout(writeNext, inputSpacingMs)
    }
    setTimeout(writeNext, startupDelayMs)

    const killer = setTimeout(() => {
      console.error(`[live-validate] ${label} TIMEOUT after ${timeoutMs}ms — killing`)
      child.kill('SIGTERM')
    }, timeoutMs)

    child.on('close', (code) => {
      clearTimeout(killer)
      res({ code, stdout, stderr })
    })
  })
}

// ---------- Per-scenario driver ----------

async function scenario(opts) {
  const {
    label,
    inputs,
    extraEnv = {},
    sharedDataDir = null,
    perProcessTimeoutMs = 180_000,
    inputSpacingMs = 3000,
  } = opts

  const dir = join(outRoot, label)
  mkdirSync(dir, { recursive: true })
  const dataDir = sharedDataDir ?? join(dir, '_data')
  mkdirSync(dataDir, { recursive: true })

  const meta = {
    label,
    startedAt: new Date().toISOString(),
    sharedDataDir: dataDir,
    extraEnv,
    processes: [],
  }

  for (let p = 0; p < inputs.length; p++) {
    const procDir = join(dir, `process-${p}`)
    mkdirSync(procDir, { recursive: true })

    const procLabel = `${label}/process-${p}`
    process.stdout.write(`  [${procLabel}] starting… `)

    const t0 = Date.now()
    const result = await runProcess({
      label: procLabel,
      dataDir,
      inputs: inputs[p],
      extraEnv,
      timeoutMs: perProcessTimeoutMs,
      inputSpacingMs,
    })
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1)

    writeFileSync(join(procDir, 'stdout.log'), result.stdout)
    writeFileSync(join(procDir, 'stderr.log'), result.stderr)
    meta.processes.push({
      process: p,
      exitCode: result.code,
      stdoutBytes: result.stdout.length,
      stderrBytes: result.stderr.length,
      wallTimeSec: Number(elapsed),
    })
    process.stdout.write(
      `exit=${result.code} wall=${elapsed}s stdout=${result.stdout.length}B stderr=${result.stderr.length}B\n`,
    )
  }

  meta.finishedAt = new Date().toISOString()
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2))
  return meta
}

// ---------- 2 scenarios ----------

const scenarios = []

// 1: verbose 30+ turn session with low budget (3000) → expect
//    truncation + warn + cache hit on the static SOUL+AGENTS+USER prefix.
//    Inputs are short greetings/stories; the goal is to grow history fast
//    and force budget pressure.
const scenario1Inputs = [
  'hi',
  'i played minecraft yesterday',
  'i usually build castles',
  'the creeper is my enemy',
  'i also like roblox',
  'my brother plays with me',
  'we built a big house',
  'then we played hide and seek',
  'i won every time',
  'after that we ate pizza',
  'pizza is my favorite food',
  'i like cheese pizza',
  'my mom makes good pizza',
  'we also watch movies together',
  'we watched avengers last week',
  'iron man is my favorite hero',
  'i want to be like him',
  'i will study hard in school',
  'math is my favorite subject',
  'my teacher is very kind',
  'i have many friends at school',
  'we play football together',
  'messi is my favorite player',
  'i want to go to the stadium',
  'my dad will take me next month',
  'i am very excited',
  'thank you for teaching me',
  'i learned a lot today',
  'see you next time',
  'bye',
  'exit',
]
scenarios.push(
  await scenario({
    label: '1-budget-enforcement',
    inputs: [scenario1Inputs],
    extraEnv: { LLM_CONTEXT_BUDGET_TOKENS: '3000' },
    perProcessTimeoutMs: 240_000,
    inputSpacingMs: 2500,
  }),
)

// 2: default budget, 4 turns → expect no truncation / no warn (regression
//    sanity for the v0.7.3 flow; verifies prompt cache works with
//    cache_control: ephemeral but doesn't push us over budget).
scenarios.push(
  await scenario({
    label: '2-default-budget-regression',
    inputs: [['hi', 'i played minecraft yesterday', 'i usually build castles', 'exit']],
  }),
)

// ---------- Summary ----------

const summary = {
  timestamp: ts,
  model: MODEL,
  hfEndpoint: HF_ENDPOINT,
  root: outRoot,
  scenarios: scenarios.map((s) => ({
    label: s.label,
    sharedDataDir: s.sharedDataDir,
    extraEnv: s.extraEnv,
    startedAt: s.startedAt,
    finishedAt: s.finishedAt,
    processes: s.processes,
  })),
}
writeFileSync(join(outRoot, 'summary.json'), JSON.stringify(summary, null, 2))

console.log('\n[live-validate] DONE')
console.log(`[live-validate] transcripts:  ${outRoot}`)
console.log(`[live-validate] summary:      ${join(outRoot, 'summary.json')}`)
console.log('\nNext steps for the operator:')
console.log('  1. Read scenario-1/process-0/stderr.log and grep for:')
console.log('       - "[cli] truncated:"        (expect at least 1)')
console.log('       - "[cli] warn: context"     (expect exactly 1)')
console.log('       - "[cli] tokens: .* cache_read=[1-9]"  (expect on turn 2+)')
console.log('  2. Read scenario-2/process-0/stderr.log and verify:')
console.log('       - NO "[cli] truncated:"  (regression check)')
console.log('       - NO "[cli] warn:"       (regression check)')
console.log('       - "[cli] summarize ok"   (v0.7.3 summarizer still works)')
console.log('  3. Write verdicts in docs/sprint/v0.7.5-validation-report.md')
console.log('  4. If issues found, file them in docs/sprint/v0.7.5-issues.md')
console.log('\nReminder: data/ is gitignored. The transcript root above will NOT be committed.')

process.exit(0)
