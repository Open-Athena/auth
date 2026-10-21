import { expect, test } from '@playwright/test'

test('revoking a live link returns a focused dashboard to the wall with its reason', async ({ page, context }, testInfo) => {
  // Authentication and data endpoints are real; omit Google UI on the wall.
  await page.route('**/auth/google/client', route => route.fulfill({ json: { clientId: null } }))
  const sandbox = await page.request.post('/api/sandbox', { data: {} })
  expect(sandbox.status()).toBe(200)
  const minted = await page.request.post('/api/admin/grants', {
    data: { name: 'revocation browser check', scopes: ['reports'], avatar: null },
  })
  expect(minted.status()).toBe(200)
  const { grant, token } = await minted.json()
  await page.goto(`/dashboard?key=${encodeURIComponent(token)}`)
  await expect(page.getByRole('heading', { name: "You're in.", exact: true })).toBeVisible()
  const failed = page.waitForResponse(response => response.url().endsWith('/api/data/private') && response.status() === 401)
  const rechecked = page.waitForResponse(response => response.url().endsWith('/api/view/whoami') && response.status() === 401)
  expect((await page.request.post(`/api/admin/grants/${grant.id}/revoke`, { data: {} })).status()).toBe(200)
  const denial = await failed
  const headers = await denial.allHeaders()
  expect({ body: await denial.json(), clear: headers['clear-site-data'], cache: headers['cache-control'] }).toEqual({
    body: { error: 'unauthenticated', reason: 'revoked' }, clear: '"cache"', cache: 'no-store',
  })
  await expect(page.getByRole('status')).toHaveText('This link was revoked.')
  await expect(page.getByRole('heading', { name: 'This dashboard is private', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: "You're in.", exact: true })).toHaveCount(0)
  expect((await context.cookies()).map(cookie => cookie.name).sort()).toEqual(['oa_demo_admin'])
  // The first data response cleared the cookie; its reason must survive the
  // subsequent anonymous whoami, rather than being replaced by a generic wall.
  const probe = await rechecked
  expect([probe.status(), await probe.json()]).toEqual([401, { error: 'unauthenticated', reason: null }])
  await page.screenshot({ path: testInfo.outputPath('revoked-wall.png'), fullPage: true })
})
