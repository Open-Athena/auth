import { expect, test } from '@playwright/test'
import { activityFeed, activityRoutes } from '../dist/activity/index.js'
import { d1ActivityStore } from '../dist/adapters/d1-activity.js'
import { testDbRaw } from '../test/d1-shim.js'

test('staff activity page does not mount its viewer for a signed-out visitor', async ({ page }) => {
  await page.route('**/api/**', route => route.fulfill({ status: 401, json: { error: 'not signed in' } }))
  await page.goto('/admin/activity')
  await expect(page.locator('main > p')).toHaveText('Staff access required. Admin')
  await expect(page.getByRole('table', { name: 'Recent activity bursts' })).toHaveCount(0)
})

test('staff activity lists recipients, filters, inspects details and saves kind policy', async ({ page }, info) => {
  const store = d1ActivityStore(testDbRaw(['activity']).db)
  const feed = activityFeed({ store, now: () => 1_800_000_000 })
  await feed.record({ id: 'pdf-1', actor: { id: 'grant:guest', name: 'Ada Lovelace', via: 'grant' }, origin: 'https://jobs.oa.dev', ts: 1_800_000_000, kind: 'view', path: '/roles/research.pdf', line: '/roles/research.pdf' })
  const handle = activityRoutes({ feed, store, requireAdmin: async () => ({ who: 'staff@example.org' }) })
  await page.route('**/api/**', route => route.fulfill({ status: 401, json: { error: 'not signed in' } }))
  await page.route('**/api/admin/whoami', route => route.fulfill({ json: { kind: 'sso', email: 'staff@example.org', scopes: ['requests'] } }))
  await page.route('**/api/activity**', async route => {
    const req = route.request()
    const headers = Object.fromEntries(Object.entries(await req.allHeaders()).filter(([key]) => !key.startsWith(':')))
    const body = req.postData()
    const response = await handle(new Request(req.url(), { method: req.method(), headers, ...(body === null ? {} : { body }) }))
    await route.fulfill({ status: response!.status, headers: Object.fromEntries(response!.headers), body: await response!.text() })
  })
  await page.goto('/admin/activity')
  const table = page.getByRole('table', { name: 'Recent activity bursts' })
  await expect(table.locator('tbody tr')).toHaveCount(1)
  await expect(table.getByRole('rowheader')).toHaveText('Ada Lovelacegrant:guest / grant')
  await page.getByRole('button', { name: 'View burst for Ada Lovelace' }).click()
  await expect(page.getByRole('heading', { name: 'Ada Lovelace', exact: true })).toBeVisible()
  await expect(page.locator('.oa-activity-lines li strong')).toHaveText(['view'])
  await expect(page.locator('.oa-activity-lines li span')).toHaveText(['/roles/research.pdf'])
  await page.getByRole('searchbox', { name: 'Actor ID' }).fill('grant:missing')
  await page.getByRole('button', { name: 'Apply filters' }).click()
  await expect(page.getByText('No activity matches these filters.', { exact: true })).toBeVisible()
  await page.getByRole('searchbox', { name: 'Actor ID' }).fill('grant:guest')
  await page.getByRole('button', { name: 'Apply filters' }).click()
  await expect(table.locator('tbody tr')).toHaveCount(1)
  await page.getByRole('combobox', { name: 'Notify view', exact: true }).selectOption('off')
  await page.getByRole('button', { name: 'Save view policy' }).click()
  await expect(page.getByRole('button', { name: 'Save view policy' })).toBeDisabled()
  expect((await feed.kinds()).view).toEqual({ record: 'line', notify: 'off' })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: `tmp/activity-admin-${info.project.name}.png`, fullPage: true })
})
