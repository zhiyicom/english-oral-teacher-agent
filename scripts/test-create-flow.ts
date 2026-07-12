// v1.0.8 §1.5 — verifies sidebar updates after create + end
// before fix: sidebar stayed at N after create (only caught up after end).
import { chromium } from '@playwright/test'

const BASE = 'http://localhost:3000'

async function getServerCount(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(async () => {
    const r = await fetch('/api/sessions')
    const d = (await r.json()) as { sessions: unknown[] }
    return d.sessions.length
  })
}

async function main() {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  })
  const page = await (await browser.newContext()).newPage()

  try {
    console.log('--- open / ---')
    await page.goto(BASE, { waitUntil: 'networkidle' })
    const initialServer = await getServerCount(page)
    const initialSidebar = await page.locator('[data-testid="session-row"]').count()
    console.log(`baseline: server=${initialServer} sidebar=${initialSidebar}`)

    console.log('--- click 开始新练习 ---')
    await page.locator('[data-testid="start-button"]').first().click()
    // Wait for: (1) navigate, (2) refresh() to fire, (3) fetch to land, (4) React to re-render
    await page.waitForTimeout(3000)

    const sessionPageMounted = (await page.locator('[data-testid="input-box"]').count()) > 0
    const afterCreateSidebar = await page.locator('[data-testid="session-row"]').count()
    const afterCreateServer = await getServerCount(page)
    console.log(
      `after create: url=${/\/session\//.test(page.url()) ? 'session' : 'other'} ` +
        `sessionPage=${sessionPageMounted ? 'mounted' : 'NO'} ` +
        `server=${afterCreateServer} sidebar=${afterCreateSidebar}`,
    )

    console.log('--- send stop ---')
    if (!sessionPageMounted) {
      throw new Error('SessionPage did not mount after click — aborting end flow check')
    }
    await page.locator('[data-testid="input-box"]').fill('stop')
    await page.locator('[data-testid="send-button"]').click()
    await page.waitForTimeout(4000)

    const endedBanner = await page.locator('[data-testid="session-ended"]').count()
    const afterEndSidebar = await page.locator('[data-testid="session-row"]').count()
    console.log(
      `after end: endedBanner=${endedBanner} sidebar=${afterEndSidebar} (server unchanged at ${afterCreateServer})`,
    )

    // Assertions
    let failed = false
    if (afterCreateSidebar !== afterCreateServer) {
      console.error(
        `✗ create-refresh broken: server has ${afterCreateServer} but sidebar shows ${afterCreateSidebar}`,
      )
      failed = true
    } else {
      console.log(`✓ sidebar caught up after create (${afterCreateSidebar} rows)`)
    }
    if (afterEndSidebar !== afterCreateServer) {
      console.error(
        `✗ end-refresh broken: server has ${afterCreateServer} but sidebar shows ${afterEndSidebar}`,
      )
      failed = true
    } else {
      console.log(`✓ sidebar caught up after end (${afterEndSidebar} rows)`)
    }

    process.exit(failed ? 1 : 0)
  } finally {
    await browser.close()
  }
}

main().catch((e: Error) => {
  console.error(e)
  process.exit(2)
})
