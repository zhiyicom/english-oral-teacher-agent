// scripts/dev-web.mjs
// v0.8.2 — Playwright webServer wrapper for `pnpm dev-web`.
//
// Why this exists:
//   Playwright launches the `webServer.command` as a child process. On this
//   Windows box, child processes spawned from bash don't inherit `pnpm` in
//   PATH even when the parent shell has it. So Playwright reports:
//     'pnpm' is not recognized as an internal or external command
//
// Fix: invoke `pnpm` through `node child_process.spawn` with `shell: true`
// so Windows resolves `pnpm.cmd` from `C:\Program Files\nodejs\`.
//
// We pass through MINIMAX_API_KEY (the server requires it on boot via
// src/config/env.ts Zod schema). Playwright forwards the parent env to
// the webServer child, so we just inherit it here.

import { spawn } from 'node:child_process'

const child = spawn('pnpm dev-web', [], {
  stdio: 'inherit',
  shell: true,
  env: process.env,
})

child.on('exit', (code) => process.exit(code ?? 0))
child.on('error', (err) => {
  console.error('dev-web.mjs: spawn failed:', err)
  process.exit(1)
})
