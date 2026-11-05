import { type BrowserContext, type Route, expect, test } from '@playwright/test'
import { authRoutes, createGate } from '../dist/index.js'
import { memoryGrantStore } from '../dist/testing/index.js'

// The package's real routes and gate over a memory store, answering the built
// demo's requests from inside Playwright: real tokens, cookies and revocation,
// with no wrangler or D1. Google and the session log are the only stubs.
const ADMIN = 'admin@example.org'

function backend() {
  const store = memoryGrantStore()
  const secret = 'browser-test-secret-0123456789'
  const adminGate = createGate({ store, secret, adminEmails: [ADMIN] })
  // Its own cookie, as in the demo: a view gate's 401 clears the cookie it owns.
  const viewGate = createGate({ store, secret, cookieName: 'oa_view' })
  const admin = authRoutes(adminGate, { basePath: '/api/admin' })
  const view = authRoutes(viewGate, { basePath: '/api/view' })

  const answer = async (route: Route, handle: (req: Request) => Promise<Response | null> | Response | null) => {
    const r = route.request()
    const headers = Object.fromEntries(Object.entries(await r.allHeaders()).filter(([k]) => !k.startsWith(':')))
    const body = r.postData()
    const res = await handle(new Request(r.url(), { method: r.method(), headers, ...(body === null ? {} : { body }) }))
    if (!res) return route.fulfill({ status: 404, json: { error: 'not found' } })
    return route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: await res.text() })
  }

  return {
    adminGate,
    async wire(context: BrowserContext) {
      await context.route('**/api/admin/**', route => answer(route, admin))
      await context.route('**/api/view/**', route => answer(route, view))
      await context.route('**/api/staff', route => route.fulfill({ status: 403, json: { error: 'forbidden' } }))
      await context.route('**/api/data/private', async route =>
        answer(route, async req => {
          const auth = await viewGate.authenticate(req)
          return auth ? Response.json({ ok: true, at: 1 }) : Response.json({ error: 'unauthenticated' }, { status: 401 })
        }),
      )
      await context.route('**/auth/google/**', route => route.fulfill({ json: { clientId: null } }))
      await context.route('**/api/slog/**', route => route.fulfill({ status: 404, json: {} }))
    },
  }
}

test('mint in <GrantsPanel>, open the link in a fresh browser, revoke it', async ({ browser, baseURL }, testInfo) => {
  const server = backend()
  const adminContext = await browser.newContext({ ...testInfo.project.use, baseURL })
  await server.wire(adminContext)
  const signed = (await server.adminGate.signIn(ADMIN, new Request('http://localhost/')))!
  const [pair] = signed.cookie.split(';')
  const [name, value] = [pair!.slice(0, pair!.indexOf('=')), pair!.slice(pair!.indexOf('=') + 1)]
  await adminContext.addCookies([{ name: name!, value: value!, url: baseURL! }])

  const page = await adminContext.newPage()
  await page.goto('/admin')
  await expect(page.getByRole('heading', { name: 'Your links' })).toBeVisible()
  await expect(page.getByText('None yet — mint one above.')).toBeVisible()
  await expect(page.getByRole('checkbox', { name: 'The dashboard' })).toBeChecked()

  await page.getByRole('textbox', { name: /^Recipient/ }).fill('Ada Lovelace')
  await page.getByRole('button', { name: 'Mint link' }).click()
  const link = page.getByRole('textbox', { name: 'Share link' })
  await expect(link).toHaveValue(/\/dashboard\?key=[\w-]+$/)
  const url = await link.inputValue()
  await expect(page.getByRole('article').getByRole('heading', { level: 3 })).toHaveCount(1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: `tmp/grants-panel-${testInfo.project.name}.png`, fullPage: true })

  // The recipient: no cookies of the admin's.
  const recipientContext = await browser.newContext({ ...testInfo.project.use, baseURL })
  await server.wire(recipientContext)
  const recipient = await recipientContext.newPage()
  await recipient.goto(url)
  await expect(recipient.getByRole('heading', { name: "You're in.", exact: true })).toBeVisible()
  expect(new URL(recipient.url()).searchParams.get('key')).toBe(null)

  // A reload loses the token, as promised: only rotating gets another.
  await page.reload()
  await expect(page.getByRole('article')).toHaveCount(1)
  await expect(link).toHaveCount(0)

  await page.getByRole('button', { name: 'Revoke' }).click()
  await page.getByRole('button', { name: 'End every session?' }).click()
  await expect(page.getByRole('article').getByText('revoked', { exact: true })).toBeVisible()

  await recipient.reload()
  await expect(recipient.getByRole('heading', { name: 'This dashboard is private', exact: true })).toBeVisible()

  // <UserMenu>: positioned in the viewport, and sign-out really signs out.
  await page.getByRole('button', { name: `Signed in as ${ADMIN}` }).click()
  await expect(page.getByRole('menuitem')).toHaveText(['Dashboard', 'Sign out'])
  // On the host's palette whichever stylesheet loaded first, in either color scheme.
  const style = (selector: string, property: 'backgroundColor' | 'color') =>
    page.locator(selector).first().evaluate((el, p) => getComputedStyle(el)[p], property)
  expect(await style('.oa-ui-um-pop', 'backgroundColor')).toBe(await style('section.panel', 'backgroundColor'))
  expect(await style('.oa-ui-um-pop', 'color')).toBe(await style('body', 'color'))
  expect(await style('.oa-ui-um-trigger', 'color')).toBe(await style('body', 'color'))
  const popover = await page.getByRole('dialog', { name: 'Account' }).boundingBox()
  const viewport = page.viewportSize()!
  expect(popover!.x >= 0 && popover!.x + popover!.width <= viewport.width).toBe(true)
  await page.screenshot({ path: `tmp/user-menu-${testInfo.project.name}.png` })
  await page.getByRole('menuitem', { name: 'Sign out' }).click()
  await expect(page.getByRole('button', { name: 'Start a sandbox' })).toBeVisible()

  await recipientContext.close()
  await adminContext.close()
})
