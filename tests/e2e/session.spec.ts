import { expect, test } from '@playwright/test'

// v0.8.3 E2E #2 — full session flow: start → 2 turns → end → back to main.
// Server runs in replay mode (default). Typing "hi" matches the greeting.json
// fixture; typing "stop" matches stop.json.

test('full session: start → 2 turns → end → back to main', async ({ page }) => {
  // 1. Navigate to main, click Start
  await page.goto('/')
  await page.getByTestId('start-button').click()
  await expect(page).toHaveURL(/\/session\/[a-f0-9-]+/, { timeout: 10_000 })

  // 2. Verify session page loaded (phase tag, input box visible)
  await expect(page.getByTestId('phase-tag')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId('input-box')).toBeVisible()

  // 3. Type "hi" and send
  await page.getByTestId('input-box').fill('hi')
  await page.getByTestId('send-button').click()

  // 4. Wait for assistant response
  await expect(page.getByTestId('assistant-message')).toBeVisible({ timeout: 30_000 })

  // 5. Type "stop" and send
  await page.getByTestId('input-box').fill('stop')
  await page.getByTestId('send-button').click()

  // 6. Wait for session ended state
  await expect(page.getByTestId('session-ended')).toBeVisible({ timeout: 30_000 })

  // 7. Navigate back to main
  await page.getByTestId('back-to-main').click()
  await expect(page).toHaveURL('/', { timeout: 5_000 })

  // 8. Verify session list has at least 1 row (the one we just created)
  await expect(page.getByTestId('session-row').first()).toBeVisible({ timeout: 5_000 })
})
