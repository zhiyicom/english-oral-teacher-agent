#!/usr/bin/env node
// scripts/live-validate-v0.7.6.mjs
// Sprint v0.7.6 — live validation for B2 (summarize_history) + D5 (topic_select)
// A+B tool paths. Replay-mode (no live API call required) — the LLM fixture
// emits the tool block, the CLI executes the actual tool + makes the 2nd
// LLM call (also matched by fixture), and the operator greps stderr/stdout
// for the expected markers.
//
// Why Replay-mode (not RUN_LIVE_LLM=1):
//   - B2/D5 tool paths are entirely CLI-side after the LLM emits a tool
//     block. The LLM's job is just to output `<tool>...</tool>` — the
//     actual history rewrite / topic selection / 2nd-call are CLI logic.
//   - The Replay fixtures (`0-summarize-history-input/followup.json`,
//     `1-topic-select-input/followup.json`) cover exactly this path.
//   - Running live adds noise (rate limits, model drift) and isn't needed
//     to verify the CLI wiring — that's what the L3 tests already do.
//
// 2 scenarios (per v0.7.6-design §7 / DoD #5):
//   1. summarize_history: 6 turn + tiny budget → truncate fires multiple
//      times, the 4th turn "compress chat" triggers B2, the
//      0-summarize-history-followup fixture is matched on the 2nd call,
//      stdout shows "Got it — let's keep going!".
//   2. topic_select: 1 turn "pick a topic" + default budget → D5
//      executes, 1-topic-select-followup fixture matches the 2nd call,
//      stdout shows "Great! Let's talk about sports.".
//
// Verdict (pass/fail) is human-judged from transcripts and written to
// docs/sprint/v0.7.6-validation-report.md.
//
// Requires:
//   - node_modules installed (tsx is a dev dep)
//   - Replay fixtures present at tests/fixtures/replay/ (checked in)
//
// This script does NOT make any product code changes. It is a dev tool.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const ROOT = resolve(__filename, '..', '..')

// ---------- Pre-flight ----------

if (!existsSync(resolve(ROOT, 'node_modules', 'tsx'))) {
  console.error('[live-validate-v0.7.6] node_modules/tsx not found. Run `pnpm install` first.')
  process.exit(1)
}
if (!existsSync(resolve(ROOT, 'tests', 'fixtures', 'replay'))) {
  console.error(
    '[live-validate-v0.7.6] tests/fixtures/replay/ not found. This script needs the Replay fixtures.',
  )
  process.exit(1)
}

// ---------- Output dir ----------

const ts = new Date().toISOString().replace(/[:.]/g, '-')
const outRoot = resolve(ROOT, 'data', 'live-validation', ts)
mkdirSync(outRoot, { recursive: true })

console.log(`[live-validate-v0.7.6] output root:  ${outRoot}`)
console.log(`[live-validate-v0.7.6] starting at:  ${new Date().toISOString()}\n`)

// ---------- Per-process runner ----------

function runProcess(opts) {
  const { label, dataDir, inputs, extraEnv = {}, timeoutMs = 60_000, inputSpacingMs = 800 } = opts
  return new Promise((res) => {
    const child = spawn(process.execPath, ['--import', 'tsx', resolve(ROOT, 'src', 'cli.ts')], {
      cwd: ROOT,
      env: { ...process.env, APP_DATA_DIR: dataDir, ...extraEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => {
      stdout += d.toString()
    })
    child.stderr.on('data', (d) => {
      stderr += d.toString()
    })

    let i = 0
    const writeNext = () => {
      if (i >= inputs.length) {
        setTimeout(() => child.stdin.end(), 1500)
        return
      }
      child.stdin.write(`${inputs[i]}\n`)
      i += 1
      setTimeout(writeNext, inputSpacingMs)
    }
    setTimeout(writeNext, 600)

    const killer = setTimeout(() => {
      console.error(`[live-validate-v0.7.6] ${label} TIMEOUT after ${timeoutMs}ms — killing`)
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
  const { label, inputs, extraEnv = {}, perProcessTimeoutMs = 60_000, inputSpacingMs = 800 } = opts

  const dir = join(outRoot, label)
  mkdirSync(dir, { recursive: true })
  const dataDir = join(dir, '_data')
  mkdirSync(dataDir, { recursive: true })

  const procDir = join(dir, 'process-0')
  mkdirSync(procDir, { recursive: true })

  process.stdout.write(`  [${label}] starting… `)
  const t0 = Date.now()
  const result = await runProcess({
    label,
    dataDir,
    inputs,
    extraEnv,
    timeoutMs: perProcessTimeoutMs,
    inputSpacingMs,
  })
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)

  writeFileSync(join(procDir, 'stdout.log'), result.stdout)
  writeFileSync(join(procDir, 'stderr.log'), result.stderr)
  const meta = {
    label,
    startedAt: new Date(t0).toISOString(),
    finishedAt: new Date().toISOString(),
    sharedDataDir: dataDir,
    extraEnv,
    exitCode: result.code,
    wallTimeSec: Number(elapsed),
    stdoutBytes: result.stdout.length,
    stderrBytes: result.stderr.length,
  }
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2))
  process.stdout.write(
    `exit=${result.code} wall=${elapsed}s stdout=${result.stdout.length}B stderr=${result.stderr.length}B\n`,
  )
  return meta
}

// ---------- 2 scenarios ----------

const scenarios = []

// Scenario 1: B2 summarize_history trigger.
// Tiny budget (100) forces truncate to fire on every turn after the first.
// The 4th user input "compress chat" matches the 0-summarize-history-input
// fixture, which emits <tool>summarize_history(...)</tool>. The CLI's B2
// branch runs the A+B 2nd LLM call, which matches the 0-summarize-history-
// followup fixture. Expected stderr markers:
//   - [cli] tool call: summarize_history(...)
//   - [cli] tool summarize: compressed N → 1 message (target=500t)
//     OR [cli] tool summarize: skipped (history too short: ...)
//   - [cli] tool 2nd-call: summarize_history(target=500)
// Expected stdout: "Got it — let's keep going! What else would you like to talk about?"
// Replay-mode (no RUN_LIVE_LLM=1 needed).
scenarios.push(
  await scenario({
    label: '1-summarize-history',
    inputs: ['hi', 'fine thanks', 'castle is cool', 'compress chat', 'exit'],
    extraEnv: { LLM_CONTEXT_BUDGET_TOKENS: '100' },
    perProcessTimeoutMs: 60_000,
    inputSpacingMs: 1000,
  }),
)

// Scenario 2: D5 topic_select trigger.
// "pick a topic" matches the 1-topic-select-input fixture, which emits
// <tool>topic_select(...)</tool>. The CLI's D5 branch runs the A+B 2nd
// LLM call, which matches the 1-topic-select-followup fixture. Expected
// stderr markers:
//   - [cli] tool call: topic_select(...)
//   - [cli] tool 2nd-call: topic_select(slug=...)
// Expected stdout: "Great! Let's talk about sports."
// Replay-mode.
scenarios.push(
  await scenario({
    label: '2-topic-select',
    inputs: ['pick a topic', 'exit'],
    extraEnv: {},
    perProcessTimeoutMs: 30_000,
    inputSpacingMs: 1000,
  }),
)

// ---------- Summary ----------

const summary = {
  timestamp: ts,
  root: outRoot,
  scenarios: scenarios.map((s) => ({
    label: s.label,
    sharedDataDir: s.sharedDataDir,
    extraEnv: s.extraEnv,
    startedAt: s.startedAt,
    finishedAt: s.finishedAt,
    exitCode: s.exitCode,
    wallTimeSec: s.wallTimeSec,
  })),
}
writeFileSync(join(outRoot, 'summary.json'), JSON.stringify(summary, null, 2))

console.log('\n[live-validate-v0.7.6] DONE')
console.log(`[live-validate-v0.7.6] transcripts:  ${outRoot}`)
console.log(`[live-validate-v0.7.6] summary:      ${join(outRoot, 'summary.json')}`)
console.log('\nNext steps for the operator:')
console.log('  Scenario 1 (summarize_history):')
console.log('    grep stderr for "[cli] tool call: summarize_history"')
console.log('    grep stderr for "[cli] tool 2nd-call: summarize_history"')
console.log('    grep stdout for "Got it — let\'s keep going"')
console.log('  Scenario 2 (topic_select):')
console.log('    grep stderr for "[cli] tool call: topic_select"')
console.log('    grep stderr for "[cli] tool 2nd-call: topic_select"')
console.log('    grep stdout for "Great! Let\'s talk about sports"')
console.log('  Write verdicts in docs/sprint/v0.7.6-validation-report.md')
console.log('  If issues found, file them in docs/sprint/v0.7.6-issues.md')
console.log('\nReminder: data/ is gitignored. The transcript root above will NOT be committed.')

process.exit(0)
