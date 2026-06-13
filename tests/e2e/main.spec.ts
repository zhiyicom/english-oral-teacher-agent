import { expect, test } from '@playwright/test'

// v0.8.2 E2E #1 — main page renders header + Start button + empty session list.
// Server returns 0 sessions on a fresh data dir, so empty-state is expected.

test('main page shows header + start button + session list', async ({ page }) => {
  await page.goto('/')

  await expect(page.locator('h1')).toContainText('English Oral Teacher')

  const startButton = page.getByTestId('start-button')
  await expect(startButton).toBeVisible()
  await expect(startButton).toHaveText('开始新练习')

  // The data dir may be fresh (empty) or pre-populated from prior sprints.
  // The real assertion is: the list resolved (no loading spinner, no error banner).
  await expect(page.getByTestId('loading')).toHaveCount(0)
  await expect(page.getByTestId('error-banner')).toHaveCount(0)

  // Either empty-state OR at least one session-row is visible.
  const emptyState = page.getByTestId('empty-state')
  const sessionRows = page.getByTestId('session-row')
  const emptyVisible = await emptyState.isVisible().catch(() => false)
  const rowCount = await sessionRows.count()
  expect(emptyVisible || rowCount > 0).toBeTruthy()

  if (emptyVisible) {
    await expect(emptyState).toContainText('暂无练习记录')
  }
})

test('clicking Start button navigates to session page', async ({ page }) => {
  await page.goto('/')

  await page.getByTestId('start-button').click()

  await expect(page).toHaveURL(/\/session\/[a-f0-9-]+/, { timeout: 10_000 })
  // v0.8.3 — SessionPage is now a real UI, not a placeholder
  await expect(page.getByTestId('phase-tag')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId('input-box')).toBeVisible()
})

test('settings route renders settings form', async ({ page }) => {
  await page.goto('/settings')

  // v0.8.4 — SettingsPage is now a real form
  await expect(page.getByTestId('save-button')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId('voice-toggle')).toBeVisible()
  await expect(page.getByTestId('debug-toggle')).toBeVisible()
})

test('history route shows error for unknown id', async ({ page }) => {
  await page.goto('/history/test-id-123')

  // v0.8.4 — HistoryPage fetches session detail, shows error for unknown ID
  await expect(page.getByTestId('error-banner')).toBeVisible({ timeout: 10_000 })
})
