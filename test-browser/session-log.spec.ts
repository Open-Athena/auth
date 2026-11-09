import { expect, test } from '@playwright/test'
import { d1SessionLogStore } from '../dist/adapters/d1-session-log.js'
import type { SlogBatch } from '../dist/core/session-log-shape.js'
import { sessionLogRoutes } from '../dist/session-log/index.js'
import { testDbRaw } from '../test/d1-shim.js'

const START = Date.UTC(2026, 9, 12, 15)
const SPAN = 108 * 3_600_000 + 43 * 60_000
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/140.0.0.0'
const CANCELLED = 'GET /api/old-selection → cancelled · 3ms'
const NETWORK_FAILURE = 'GET /api/network → failed · 4ms · TypeError: Failed to fetch'
const SERVER_FAILURE = 'POST /api/scan → 503 · 1200ms · upstream unavailable'

test.use({ locale: 'en-US', timezoneId: 'UTC' })

test('sessions distinguish cancellation from failures and keep multi-day timelines compact', async ({ page }, info) => {
  const { db, raw } = testDbRaw(['session-log'])
  const store = d1SessionLogStore(db)
  const batches: SlogBatch[] = [
    {
      sid: 'sid-cancelled', pid: 'pid-cancelled', seq: 0, build: 'disky-test',
      events: [
        { t: START, k: 'start', u: '/disky' },
        { t: START + 1000, k: 'api', u: '/api/old-selection', s: 0, ms: 3, err: 'abort' },
      ],
    },
    {
      sid: 'sid-failure', pid: 'pid-failure', seq: 0, build: 'disky-test',
      events: [
        { t: START, k: 'start', u: '/disky' },
        { t: START + 1000, k: 'api', u: '/api/old-selection', s: 0, ms: 3, err: 'abort' },
        { t: START + 187_000, k: 'api', u: '/api/network', s: 0, ms: 4, err: 'TypeError: Failed to fetch' },
        { t: START + 3_720_000, k: 'api', m: 'POST', u: '/api/scan', s: 503, ms: 1200, err: 'upstream unavailable' },
        { t: START + SPAN, k: 'nav', u: '/disky?path=checkpoints' },
      ],
    },
  ]

  try {
    for (const batch of batches) {
      const subjectName = batch.sid === 'sid-cancelled' ? 'Disky cancellation' : 'Disky failure'
      expect(await store.ingest(
        { email: 'viewer@example.test', via: 'sso', subjectName },
        UA,
        batch,
        Math.floor((START + SPAN) / 1000),
      )).toBe('stored')
    }
    // Keep the real routes and D1 error counts; only the demo's staff identity is mocked.
    const handle = sessionLogRoutes({
      store,
      identify: async () => null,
      requireAdmin: async () => ({ who: 'staff@example.test' }),
    })
    await page.clock.setFixedTime(START + SPAN)
    await page.route('**/api/**', route => route.fulfill({ status: 401, json: { error: 'not signed in' } }))
    await page.route('**/api/admin/whoami', route => route.fulfill({
      json: { kind: 'sso', email: 'staff@example.test', scopes: ['requests'] },
    }))
    await page.route('**/api/session-log**', async route => {
      const request = route.request()
      const response = await handle(new Request(request.url(), { method: request.method() }))
      if (!response) throw new Error(`Unhandled session-log request: ${request.url()}`)
      await route.fulfill({
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: await response.text(),
      })
    })

    await page.goto('/admin/sessions')
    const list = page.locator('.oa-slog-table tbody tr')
    await expect(list.locator('td:first-child')).toHaveText(['Disky failure', 'Disky cancellation'])
    await expect(list.locator('td:nth-child(4)')).toHaveText(['4d 12h', '1s'])
    await expect(list.locator('td:nth-child(5)')).toHaveText(['5', '2'])
    await expect(list.locator('td:nth-child(6)')).toHaveText(['2', '0'])
    await expect(list.nth(0)).toHaveClass('oa-slog-has-err')
    await expect(list.nth(1)).toHaveClass('')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: `tmp/session-log-list-${info.project.name}.png`, fullPage: true })

    await list.nth(1).getByRole('link').click()
    await expect(page).toHaveURL('/admin/sessions/sid-cancelled')
    await expect(page.getByRole('heading', { name: 'Disky cancellation', exact: true })).toBeVisible()
    await expect(page.locator('.oa-slog-meta')).toHaveText(
      'Oct 12, 3:00:00 PM · 1s · 2 events · 0 errors · Chrome · macOS · build disky-test · sid-cancelled',
    )
    const events = page.locator('.oa-slog-timeline tbody tr')
    await expect(events.locator('.oa-slog-ev')).toHaveText(['page load /disky', CANCELLED])
    await expect(events.nth(1)).toHaveClass('')
    await expect(events.nth(1).locator('.oa-slog-dot')).toHaveClass('oa-slog-dot oa-slog-lane-api')
    await expect(page.locator('.oa-slog-has-err, .oa-slog-err, .oa-slog-tick-err')).toHaveCount(0)
    await page.getByRole('radio', { name: 'errors', exact: true }).check()
    await expect(events).toHaveCount(0)

    await page.getByRole('link', { name: 'sessions', exact: true }).click()
    await expect(list.locator('td:first-child')).toHaveText(['Disky failure', 'Disky cancellation'])
    const filtered = page.waitForResponse(response =>
      new URL(response.url()).pathname === '/api/session-log/sessions'
      && new URL(response.url()).search === '?errors=1',
    )
    await page.getByRole('checkbox', { name: 'with errors', exact: true }).check()
    expect((await filtered).status()).toBe(200)
    await expect(page).toHaveURL('/admin/sessions?err=1')
    await expect(list.locator('td:first-child')).toHaveText(['Disky failure'])
    await expect(list.locator('td:nth-child(6)')).toHaveText(['2'])

    await list.getByRole('link').click()
    await expect(page).toHaveURL('/admin/sessions/sid-failure')
    await expect(page.getByRole('heading', { name: 'Disky failure', exact: true })).toBeVisible()
    await expect(page.locator('.oa-slog-meta')).toHaveText(
      'Oct 12, 3:00:00 PM · 4d 12h · 5 events · 2 errors · Chrome · macOS · build disky-test · sid-failure',
    )
    await expect(events.locator('.oa-slog-ev')).toHaveText([
      'page load /disky', CANCELLED, NETWORK_FAILURE, SERVER_FAILURE, '/disky?path=checkpoints',
    ])
    await expect(events.locator('td:first-child')).toHaveText(['+0.000s', '+1.000s', '+3m 07s', '+1h 02m', '+4d 12h'])
    await expect(events.locator('td:nth-child(2)')).toHaveText([
      '15:00:00.000', '15:00:01.000', '15:03:07.000', '16:02:00.000', 'Oct 17 03:43:00.000',
    ])
    await expect(page.locator('.oa-slog-strip figcaption > .oa-slog-dim')).toHaveText('+0.000s → +4d 12h')
    await expect(events.nth(1)).toHaveClass('')
    await expect(events.nth(2)).toHaveClass('oa-slog-has-err')
    await expect(events.nth(3)).toHaveClass('oa-slog-has-err')
    await expect(page.locator('.oa-slog-tick')).toHaveCount(5)
    await expect(page.locator('.oa-slog-tick-err')).toHaveCount(2)
    await expect(page.locator('.oa-slog-tick').nth(1)).toHaveClass('oa-slog-tick oa-slog-lane-api')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    expect(await events.nth(1).locator('.oa-slog-ev').evaluate(cell => cell.getBoundingClientRect().width >= 280)).toBe(true)
    if (info.project.name === 'mobile') {
      const scroll = page.locator('.oa-slog-timeline-box')
      expect(await scroll.evaluate(box => box.scrollWidth > box.clientWidth)).toBe(true)
      await events.nth(1).locator('.oa-slog-ev').scrollIntoViewIfNeeded()
    }
    await page.screenshot({ path: `tmp/session-log-timeline-${info.project.name}.png`, fullPage: true })

    await page.getByRole('radio', { name: 'errors', exact: true }).check()
    await expect(events.locator('.oa-slog-ev')).toHaveText([NETWORK_FAILURE, SERVER_FAILURE])
    await expect(events.locator('td:first-child')).toHaveText(['+3m 07s', '+1h 02m'])
    await expect(events.locator('.oa-slog-dot')).toHaveClass([
      'oa-slog-dot oa-slog-lane-error', 'oa-slog-dot oa-slog-lane-error',
    ])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: `tmp/session-log-errors-${info.project.name}.png`, fullPage: true })

    await page.getByRole('radio', { name: 'requests', exact: true }).check()
    await expect(events.locator('.oa-slog-ev')).toHaveText([CANCELLED, NETWORK_FAILURE, SERVER_FAILURE])
  } finally {
    await page.unrouteAll({ behavior: 'wait' })
    raw.close()
  }
})
