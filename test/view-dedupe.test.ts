// View rows dedupe per browser, not per grant (specs/done/view-dedupe-per-browser.md): a second browser opening the
// same share link within the hour of an earlier view is a different person, and gets its own row.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { d1AuditSink, d1GrantStore } from '../src/adapters/d1.js'
import { createGate } from '../src/core/gate.js'
import { domainPolicy } from '../src/core/policy.js'
import { testDb } from './d1-shim.js'

const SECRET = 'test-secret-0123456789abcdef'
const NOW = Date.parse('2026-11-16T18:00:00Z')
const HOST = 'https://jobs.example'

let db: D1Database
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  db = testDb()
})
afterEach(() => { vi.useRealTimers() })

function setup() {
  const gate = createGate({
    store: d1GrantStore(db), audit: d1AuditSink(db), secret: SECRET, logViews: true,
    adminEmails: ['ryan@oa.test'], policy: domainPolicy(['oa.test'], ['*']),
  })
  const page = (path: string, headers: Record<string, string> = {}) =>
    new Request(`${HOST}${path}`, { headers: { 'CF-Connecting-IP': '198.51.100.7', 'User-Agent': 'Chrome', ...headers } })
  /** A browser: redeems the link (`?key=` → 302 + cookie), then loads `path` with that cookie. */
  const browser = async (token: string, path: string) => {
    const res = await gate.handleKeyParam(page(`${path}?key=${token}`))
    const cookie = res!.headers.get('set-cookie')!.split(';')[0]!
    const view = async (headers: Record<string, string> = {}) => (await gate.authenticate(page(path, { cookie, ...headers })))?.kind ?? null
    return { view }
  }
  const views = async () =>
    (await db.prepare(`SELECT ts, path, session_sub FROM access_log WHERE event = 'view' ORDER BY id`).all<{ ts: number; path: string; session_sub: string }>()).results
  return { gate, page, browser, views }
}

describe('view dedupe', () => {
  it('two browsers on one link in one hour each log their view; one browser repeating does not', async () => {
    const t = setup()
    const { grant, token } = await t.gate.mint({ name: 'Hilary', scopes: ['jd'], maxRedeems: 3, createdBy: 'ryan@oa.test' })
    const s = NOW / 1000
    const a = await t.browser(token, '/eng-mgr-nyc')
    const first = await a.view()
    vi.setSystemTime(NOW + 10 * 60_000)
    const again = await a.view()
    vi.setSystemTime(NOW + 50 * 60_000)
    const b = await t.browser(token, '/eng-mgr-nyc')
    const second = await b.view()
    expect([first, again, second, await t.views()]).toEqual([
      'grant', 'grant', 'grant',
      [
        { ts: s, path: '/eng-mgr-nyc', session_sub: `g:${grant.id}` },
        { ts: s + 50 * 60, path: '/eng-mgr-nyc', session_sub: `g:${grant.id}` },
      ],
    ])
  })

  it('without a cookie (a presented key), one network and browser dedupes; another one logs', async () => {
    const t = setup()
    const { token } = await t.gate.mint({ name: 'Hilary', scopes: ['jd'], createdBy: 'ryan@oa.test' })
    const bearer = (headers: Record<string, string> = {}) => t.gate.authenticate(t.page('/eng-mgr-nyc', { authorization: `Bearer ${token}`, ...headers }))
    await bearer()
    await bearer()
    await bearer({ 'CF-Connecting-IP': '203.0.113.9' })
    await bearer({ 'User-Agent': 'Firefox' })
    expect((await t.views()).length).toBe(3)
  })
})
