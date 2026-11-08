import { expect, test } from '@playwright/test'
import { createGate, domainPolicy } from '../dist/index.js'
import { d1GrantStore } from '../dist/adapters/d1.js'
import { d1ClientRegistry } from '../dist/adapters/d1-provider.js'
import { adminRoutes } from '../broker/src/admin.js'
import { testDbRaw } from '../test/d1-shim.js'

async function preview() {
  const { db } = testDbRaw(['provider'])
  const gate = createGate({ store: d1GrantStore(db), secret: 'browser-table-test-secret', policy: domainPolicy(['example.org'], ['member']) })
  const registry = d1ClientRegistry(db)
  const actor = 'admin@example.org'
  await registry.create({ id: 'oa-jobs', name: 'Job descriptions', secretHash: 'test-only-hash', redirectUris: ['https://jobs.oa.dev/auth/oa/callback'] }, actor)
  await registry.create({ id: 'disky-gcs-dev', name: 'GCS usage (dev)', secretHash: 'test-only-hash', redirectUris: ['https://dev.gcs.oa.dev/auth/oa/callback'] }, actor)
  const handle = adminRoutes({ gate, registry, staticClients: [], admins: new Set([actor]), redirectDomains: ['oa.dev'], signInPath: '/signin' })
  const signed = (await gate.signIn(actor, new Request('https://login.test')))!
  const response = await handle(new Request('https://login.test/admin', { headers: { cookie: signed.cookie.split(';')[0]! } }))
  return response!.text()
}

test('broker app table is compact and expands only the selected editor', async ({ page }, info) => {
  const html = await preview()
  await page.route('**/broker-admin-preview', route => route.fulfill({ contentType: 'text/html', body: html }))
  await page.goto('/broker-admin-preview')
  const table = page.getByRole('table', { name: 'Registered apps' })
  await expect(table.getByRole('columnheader')).toHaveText(['App', 'Callbacks', 'Status', 'Actions'])
  await expect(table.locator('.app-name')).toHaveText(['GCS usage (dev)', 'Job descriptions'])
  const editors = table.locator('.app-editor')
  expect(await editors.evaluateAll(rows => rows.map(row => (row as HTMLElement).hidden))).toEqual([true, true])
  await table.getByRole('button', { name: 'Edit', exact: true }).first().click()
  expect(await editors.evaluateAll(rows => rows.map(row => (row as HTMLElement).hidden))).toEqual([false, true])
  await expect(table.getByRole('button', { name: 'Save changes' })).toBeVisible()
  await expect(table.getByRole('checkbox', { name: 'The old secret stops working now' })).not.toBeChecked()
  await table.getByRole('button', { name: 'Edit', exact: true }).first().click()
  expect(await editors.evaluateAll(rows => rows.map(row => (row as HTMLElement).hidden))).toEqual([true, true])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  if (info.project.name !== 'mobile') {
    expect(await table.locator('.app-row').evaluateAll(rows => rows.every(row => row.getBoundingClientRect().height < 100))).toBe(true)
  }
  await page.screenshot({ path: `tmp/broker-table-${info.project.name}.png`, fullPage: true })
})
