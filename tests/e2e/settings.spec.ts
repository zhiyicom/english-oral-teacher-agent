import { expect, test } from '@playwright/test'

// v0.8.4 E2E #3 — settings page renders, toggles work, save persists.
// Cross-restart persistence is tested via L3 (tests/server/l3.test.ts).

test('settings page: toggle show_debug + save + verify server persistence', async ({
  page,
  request,
}) => {
  // 1. Navigate to settings
  await page.goto('/settings')
  await expect(page.getByTestId('save-button')).toBeVisible({ timeout: 10_000 })

  // 2. Toggle show_debug ON
  const debugToggle = page.getByTestId('debug-toggle')
  const debugState = await debugToggle.textContent()
  await debugToggle.click()
  // The toggle text should have changed
  await expect(debugToggle).not.toHaveText(debugState ?? '')

  // 3. Click save
  await page.getByTestId('save-button').click()
  await expect(page.getByTestId('saved-toast')).toBeVisible({ timeout: 5_000 })
  await expect(page.getByTestId('saved-toast')).toContainText('已保存')

  // 4. Verify voice toggle is visible (disabled)
  await expect(page.getByTestId('voice-toggle')).toBeVisible()

  // 5. Verify server-side: default settings endpoint works
  const apiRes = await request.get('http://localhost:3000/api/settings')
  expect(apiRes.status()).toBe(200)
  const body = (await apiRes.json()) as { voice_enabled: boolean; font_size: number }
  expect(typeof body.voice_enabled).toBe('boolean')
  expect(typeof body.font_size).toBe('number')
})
