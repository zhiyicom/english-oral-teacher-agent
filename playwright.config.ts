import { defineConfig, devices } from '@playwright/test'

// v0.8.2 — Playwright E2E config.
// webServer runs `pnpm dev-web`, which starts:
//   - Hono server on http://localhost:3000
//   - Vite dev on http://localhost:5173 (proxy /api/* → 3000)
// Playwright waits for 5173 to respond, runs the spec, kills the process group.
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:5173',
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // v0.8.2 — Use `node` to run a one-shot script that delegates to `pnpm dev-web`.
    // Reason: on this Windows box, child processes spawned from bash don't inherit
    // the system PATH (neither `pnpm` nor `node` resolve). We pass an explicit PATH
    // via `env` so cmd.exe (which Playwright uses to launch the command) can find
    // both `node` and `pnpm.cmd`.
    command: 'node scripts/dev-web.mjs',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      // Force-resolve PATH for the spawned shell so `pnpm` and `node` are found.
      // Bash on this Windows box strips the system PATH from child processes.
      PATH: 'C:\\Program Files\\nodejs;C:\\Program Files\\Git\\cmd;C:\\Windows\\System32',
    },
  },
})
