import { expect, test } from '@playwright/test'

test('App B signs in through the broker: silent fails, one sign-in there, then silent needs no page', async ({ page }, testInfo) => {
  await page.route('**/auth/google/client', route => route.fulfill({ json: { clientId: null } }))
  const email = `broker-${Date.now()}@example.test`
  const visited: string[] = []
  page.on('framenavigated', f => {
    if (f === page.mainFrame()) visited.push(new URL(f.url()).pathname)
  })

  // No broker session: the silent attempt comes back with a reason, not a page.
  await page.goto('/rp/start?next=/rp&prompt=none')
  await expect(page).toHaveURL(/\/rp\?sso=login_required$/)
  await expect(page.getByRole('status')).toHaveText(
    "The silent attempt came back empty: you're not signed in at the broker. Sign in there, then App B needs no page at all.",
  )

  // Interactive: the broker's sign-in page, then straight back to App B.
  await page.getByRole('link', { name: 'Sign in with the broker' }).click()
  await expect(page.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible()
  await page.getByLabel('Or use any email address').fill(email)
  await page.getByRole('button', { name: 'Email me a code' }).click()
  await expect(page.getByLabel('The 6-digit code')).toBeVisible()
  const { code } = (await (await page.request.get('/auth/email/outbox')).json()) as { code: string }
  await page.getByLabel('The 6-digit code').fill(code)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page).toHaveURL(/\/rp$/)
  await expect(page.locator('main > p').nth(1)).toHaveText(`Signed in to App B as ${email}, vouched for by the broker's ID token.`)
  await page.screenshot({ path: testInfo.outputPath('rp-signed-in.png'), fullPage: true })

  // Out of App B only; the broker still knows this browser, so silent works.
  await page.getByRole('button', { name: 'Sign out of App B' }).click()
  await expect(page.locator('main > p').nth(1)).toHaveText('Not signed in to App B.')
  visited.length = 0
  await page.getByRole('link', { name: 'Try silently (prompt=none)' }).click()
  await expect(page.locator('main > p').nth(1)).toHaveText(`Signed in to App B as ${email}, vouched for by the broker's ID token.`)
  expect(visited).toEqual(['/rp'])
})
