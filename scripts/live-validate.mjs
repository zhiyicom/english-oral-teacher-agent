#!/usr/bin/env node
// scripts/live-validate.mjs
// Sprint v0.7.4 — live LLM smoke for v0.7 / v0.7.1 / v0.7.2 / v0.7.3.
//
// Runs 5 scenarios serially, each spawning 1 or 2 CLI child processes
// against the real MiniMax-M3 endpoint. Captures stdout/stderr to
// data/live-validation/<ts>/. Verdict (pass/fail) is human-judged from
// transcripts and written to docs/sprint/v0.7.4-validation-report.md.
//
// Requires:
//   - API_KEY in env (NOT read from .env — operator provides)
//   - node_modules installed (tsx is a dev dep)
//   - Network access to ANTHROPIC_BASE_URL + HF_ENDPOINT (default mirror)
//
// This script does NOT make any product code changes. It is a dev tool.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const ROOT = resolve(__filename, '..', '..')

// ---------- Pre-flight ----------

if (!process.env.API_KEY) {
  console.error('[live-validate] API_KEY is not set.')
  console.error('  Run as:  API_KEY=sk-... node scripts/live-validate.mjs')
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
 * @param {string} opts.label       human label for logs
 * @param {string} opts.dataDir     APP_DATA_DIR to pass to the child
 * @param {string[]} opts.inputs    lines to write to stdin (one per turn)
 * @param {number} [opts.timeoutMs] hard timeout; SIGTERM on exceed
 * @param {number} [opts.inputSpacingMs] delay between input lines
 * @param {number} [opts.startupDelayMs] delay before the FIRST input
 * @returns {Promise<{code: number|null, stdout: string, stderr: string}>}
 */
function runProcess(opts) {
  const {
    label,
    dataDir,
    inputs,
    timeoutMs = 90_000,
    inputSpacingMs = 4000,
    startupDelayMs = 1000,
  } = opts

  return new Promise((res) => {
    const child = spawn(process.execPath, ['--import', 'tsx', resolve(ROOT, 'src', 'cli.ts')], {
      cwd: ROOT,
      env: {
        ...process.env,
        APP_DATA_DIR: dataDir,
        HF_ENDPOINT,
      },
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

/**
 * Run a single scenario: 1+ CLI processes, share a data dir, write transcripts
 * to per-process subdirs.
 *
 * @param {object} opts
 * @param {string} opts.label
 * @param {string[][]} opts.inputs          inputs[processIndex] = lines
 * @param {string} [opts.sharedDataDir]     if set, all processes use this data dir
 * @param {number} [opts.perProcessTimeoutMs]
 * @param {number} [opts.inputSpacingMs]
 * @returns {Promise<object>}               meta
 */
async function scenario(opts) {
  const {
    label,
    inputs,
    sharedDataDir = null,
    perProcessTimeoutMs = 90_000,
    inputSpacingMs = 4000,
  } = opts

  const dir = join(outRoot, label)
  mkdirSync(dir, { recursive: true })
  const dataDir = sharedDataDir ?? join(dir, '_data')
  mkdirSync(dataDir, { recursive: true })

  const meta = {
    label,
    startedAt: new Date().toISOString(),
    sharedDataDir: dataDir,
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

// ---------- 5 scenarios ----------

const scenarios = []

// 1: baseline — single process, 4 turns
scenarios.push(
  await scenario({
    label: '1-baseline',
    inputs: [['hi', 'i played minecraft yesterday', 'i usually build castles', 'exit']],
  }),
)

// 2: mark_mistake — single process, student makes a grammar mistake
scenarios.push(
  await scenario({
    label: '2-mark-mistake',
    inputs: [['hi', 'i go to school yesterday', 'i am fine thanks', 'exit']],
  }),
)

// 3: dedup — single process, same mistake twice
scenarios.push(
  await scenario({
    label: '3-dedup',
    inputs: [['hi', 'i go to school yesterday', 'i go to school yesterday', 'exit']],
  }),
)

// 4: cross-session retrieval — V741-001 fix. Originally this scenario was
// 2 processes: A wrote 1 session, B was supposed to see it via startup
// retrieval. But B's `lastReview` IS A, and the startup retrieval excludes
// `lastReview.sessionId` (correctly — "Last session" already shows A's
// summary in the [System Context] block). With only 1 prior session, the
// exclude filters the only candidate → 0 results. v0.7.6 fix: spawn 3
// processes sharing `_data/`:
//   - p0: minecraft session (becomes A)
//   - p1: roblox session (becomes B = new lastReview for p2)
//   - p2: p2's lastReview=B; candidates=[A, B]; exclude B → 1 result (A)
scenarios.push(
  await scenario({
    label: '4-cross-session-retrieval',
    inputs: [
      ['hi', 'i played minecraft yesterday', 'i usually build castles', 'exit'],
      ['hi', 'i also like roblox', 'exit'],
      ['hi', 'fine thanks', 'exit'],
    ],
    sharedDataDir: join(outRoot, '4-cross-session-retrieval', '_data'),
  }),
)

// 5: memory_search A+B — process A seeds, process B triggers memory_search
scenarios.push(
  await scenario({
    label: '5-memory-search',
    inputs: [
      ['hi', 'i played minecraft yesterday', 'i usually build castles', 'exit'],
      ['earlier session', 'exit'],
    ],
    sharedDataDir: join(outRoot, '5-memory-search', '_data'),
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
console.log('  1. Read each scenario-N/process-X/{stdout,stderr}.log')
console.log('  2. Write per-scenario verdicts in docs/sprint/v0.7.4-validation-report.md')
console.log('  3. If issues found, file them in docs/sprint/v0.7.4-issues.md')
console.log('     (per-issue: sprint-link, severity, repro, suggested next sprint)')
console.log('\nReminder: data/ is gitignored. The transcript root above will NOT be committed.')

process.exit(0)
