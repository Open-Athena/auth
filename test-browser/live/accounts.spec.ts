import { expect, test } from '@playwright/test'

/** Mint a real link through the demo's admin sandbox (its own cookie, not the dashboard's). */
async function mint(request: import('@playwright/test').APIRequestContext, subjectName: string) {
  const res = await request.post('/api/admin/grants', { data: { name: subjectName, subjectName, scopes: ['reports'], avatar: null } })
  expect(res.status()).toBe(200)
  return (await res.json()) as { grant: { id: string }; token: string }
}

test('a second link is held, not forced; taking it keeps the first, and the menu switches back', async ({ page, context }, testInfo) => {
  await page.route('**/auth/google/client', route => route.fulfill({ json: { clientId: null } }))
  expect((await page.request.post('/api/sandbox', { data: {} })).status()).toBe(200)
  const first = await mint(page.request, 'Ada Member')
  const second = await mint(page.request, 'Bea Guest')
  const redeems = async (id: string) =>
    ((await (await page.request.get('/api/admin/grants')).json()).grants as { id: string; redeems: number }[]).find(g => g.id === id)!.redeems

  // No login yet: the first link signs in.
  await page.goto(`/dashboard?key=${encodeURIComponent(first.token)}`)
  await expect(page.locator('.chip-name')).toHaveText('Ada Member')

  // Signed in: the second link is held for a choice, and spends nothing.
  await page.goto(`/dashboard?key=${encodeURIComponent(second.token)}`)
  await expect(page.getByRole('status').filter({ hasText: 'You opened a share link for Bea Guest' })).toBeVisible()
  await expect(page.locator('.chip-name')).toHaveText('Ada Member')
  expect(await redeems(second.grant.id)).toBe(0)
  await page.screenshot({ path: testInfo.outputPath('held.png'), fullPage: true })

  await page.getByRole('button', { name: 'Continue as Bea Guest' }).click()
  await expect(page.locator('.chip-name')).toHaveText('Bea Guest')
  expect(await redeems(second.grant.id)).toBe(1)

  // Both are on the menu; switching back needs no link and no sign-in.
  await page.locator('.accounts-menu summary').click()
  await expect(page.locator('.account')).toHaveText([/Ada Member.*share link/, /Bea Guest.*share link.*current/])
  await page.screenshot({ path: testInfo.outputPath('menu.png'), fullPage: true })
  await page.locator('.account-switch', { hasText: 'Ada Member' }).click()
  await expect(page.locator('.chip-name')).toHaveText('Ada Member')

  await page.locator('.accounts-menu summary').click()
  await page.getByRole('button', { name: 'Sign out of all accounts' }).click()
  await expect(page.getByRole('heading', { name: 'This dashboard is private', exact: true })).toBeVisible()
  expect((await context.cookies()).map(c => c.name).sort()).toEqual(['oa_demo_admin'])
})
