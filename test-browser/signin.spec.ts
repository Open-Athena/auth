import { expect, test } from '@playwright/test'

// Mock only auth/provider boundaries. The actual demo, package components and
// styles run in Chromium; Google's real consent/FedCM UI needs a manual check.
test('remembered accounts are distinct hinted links and fit the viewport', async ({ page }, testInfo) => {
  await page.route('**/api/view/whoami', route => route.fulfill({ status: 401, json: { error: 'unauthenticated' } }))
  await page.route('**/auth/google/client', route => route.fulfill({ json: { clientId: 'test-client' } }))
  await page.route('**/auth/google/onetap/nonce', route => route.fulfill({ json: {
    nonce: 'test-nonce', loginHint: 'ryan.williams@openathena.ai',
    loginHints: ['ryan.williams@openathena.ai', 'ryan@runsascoded.com'],
  } }))
  await page.route('https://accounts.google.com/gsi/client', route => route.fulfill({
    contentType: 'application/javascript',
    body: 'window.google={accounts:{id:{initialize(){},renderButton(){},prompt(){},cancel(){}}}};',
  }))
  await page.goto('/dashboard')
  const rows = page.locator('.signin-panel > a.google')
  await expect(rows).toHaveCount(2)
  expect(await rows.locator('.account-email').allTextContents()).toEqual([
    'ryan.williams@openathena.ai', 'ryan@runsascoded.com',
  ])
  expect(await rows.evaluateAll(links => links.map(link => new URL((link as HTMLAnchorElement).href).searchParams.get('account')))).toEqual([
    'ryan.williams@openathena.ai', 'ryan@runsascoded.com',
  ])
  const switchLink = page.getByRole('link', { name: /Use another Google account/ })
  await expect(switchLink).toHaveCount(1)
  expect(new URL(await switchLink.getAttribute('href') ?? '', page.url()).searchParams.get('account')).toBe('choose')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  expect(await rows.evaluateAll(links => links.map(link => link.scrollWidth <= link.clientWidth))).toEqual([true, true])
  await page.screenshot({ path: `tmp/remembered-accounts-${testInfo.project.name}.png`, fullPage: true })
})
