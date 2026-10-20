import { expect, test } from '@playwright/test'

for (const path of ['/', '/vanilla', '/vue', '/react']) {
  for (const named of [true, false]) {
    test(`${path} real ${named ? 'named' : 'anonymous'} link and shared session`, async ({ page }, testInfo) => {
      await page.goto(path)
      await expect(page.getByRole('heading', { name: 'Private workspace', exact: true })).toBeVisible()
      await page.getByRole('link', { name: named ? 'Open named link' : 'Open anonymous link', exact: true }).click()
      await expect(page.getByRole('heading', { name: "You're in.", exact: true })).toBeVisible()
      await expect(page.getByText(named ? 'Mona Octocat' : 'Anonymous link', { exact: true })).toBeVisible()
      expect(new URL(page.url()).search).toBe('')
      const whoami = await page.request.get('/api/view/whoami')
      const identity = await whoami.json()
      expect([whoami.status(), identity.kind, identity.subject?.name ?? null]).toEqual([200, 'grant', named ? 'Mona Octocat' : null])
      await page.screenshot({ path: testInfo.outputPath('signed-in.png'), fullPage: true })
      // A different framework reads the same real HttpOnly session cookie.
      await page.goto(path === '/vue' ? '/react' : '/vue')
      await expect(page.getByText(named ? 'Mona Octocat' : 'Anonymous link', { exact: true })).toBeVisible()
      await page.getByRole('button', { name: 'Sign out', exact: true }).click()
      await expect(page.getByRole('heading', { name: 'Private workspace', exact: true })).toBeVisible()
      expect((await page.request.get('/api/view/whoami')).status()).toBe(401)
      await page.screenshot({ path: testInfo.outputPath('signed-out.png'), fullPage: true })
    })
  }
}

test('demo mint redirects only to known local examples', async ({ request }) => {
  const response = await request.get('/api/demo-link?named=0&next=https://attacker.example', { maxRedirects: 0 })
  const location = new URL(response.headers().location!, 'http://localhost:4187')
  expect([response.status(), location.origin, location.pathname, location.searchParams.get('key')?.length]).toEqual([
    302, 'http://localhost:4187', '/dashboard', 32,
  ])
})
