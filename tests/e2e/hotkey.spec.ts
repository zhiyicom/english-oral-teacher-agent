import { expect, test } from '@playwright/test'

test('set hotkey via UI click, reload, verify persists', async ({ page }) => {
  await page.goto('/settings')
  await expect(page.getByTestId('save-button')).toBeVisible({ timeout: 10_000 })

  // Find the mic hotkey button (the one showing "未设置" or placeholder in the hotkey section)
  const section = page.locator('h3:has-text("快捷键")').locator('..')
  const hotkeyBtns = section.locator('button')
  const micBtn = hotkeyBtns.first() // first hotkey button = microphone

  const beforeText = await micBtn.textContent()
  console.log('before click:', beforeText)

  // Click to enter capture mode
  await micBtn.click()
  // Wait for capture mode
  const capturingText = await micBtn.textContent()
  console.log('after click:', capturingText)
  // If the button is in a form or something, click might not work.
  // Let's try keyboard focus approach instead:
  await micBtn.focus()
  // Press hotkey combo while focused
  await page.keyboard.press('F2')

  // Verify the button now shows F2 (not 未设置 or placeholder)
  const afterSet = await micBtn.textContent()
  console.log('after setting F2:', afterSet)
  expect(afterSet).toContain('F2')

  // Verify localStorage
  const stored1 = await page.evaluate(() =>
    localStorage.getItem('settings:mic_hotkey'),
  )
  console.log('localStorage after set:', stored1)
  expect(stored1).toContain('F2')

  // Reload
  await page.reload()
  await expect(page.getByTestId('save-button')).toBeVisible({ timeout: 10_000 })

  // Find the mic button again
  const section2 = page.locator('h3:has-text("快捷键")').locator('..')
  const micBtn2 = section2.locator('button').first()
  const afterReload = await micBtn2.textContent()
  console.log('after reload:', afterReload)
  expect(afterReload).toContain('F2')
})
