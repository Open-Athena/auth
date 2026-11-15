// Staff clicking a share link drafted for someone else stay themselves, and `?key=-` ends a link session
// (specs/done/staff-clicking-share-links.md). Single-session gate over D1; retained mode is in retained-gate.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { d1AuditQuery, d1AuditSink, d1GrantStore } from '../src/adapters/d1.js'
import { CLEAR_KEY, createGate, type GateOptions } from '../src/core/gate.js'
import { domainPolicy } from '../src/core/policy.js'
import { testDb } from './d1-shim.js'

const SECRET = 'test-secret-0123456789abcdef'
const NOW = Date.parse('2026-11-15T16:00:00Z')
const HOST = 'https://jobs.example'

let db: D1Database
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  db = testDb()
})
afterEach(() => { vi.useRealTimers() })

function setup(more: Partial<GateOptions> = {}) {
  const gate = createGate({
    store: d1GrantStore(db), audit: d1AuditSink(db), secret: SECRET, adminEmails: ['ryan@oa.test'], policy: domainPolicy(['oa.test'], ['*']), ...more,
  })
  /** A page request from a browser holding `cookie`. */
  const page = (path: string, cookie = '') => new Request(`${HOST}${path}`, { headers: cookie ? { cookie } : {} })
  const signIn = async (email: string) => (await gate.signIn(email, page('/cb')))!.cookie.split(';')[0]!
  const mint = () => gate.mint({ name: 'Hilary', scopes: ['jd'], maxRedeems: 1, createdBy: 'ryan@oa.test' })
  const step = async (path: string, cookie = ''): Promise<[number, string | null, string | null]> => {
    const res = (await gate.handleKeyParam(page(path, cookie)))!
    return [res.status, res.headers.get('location'), res.headers.get('set-cookie')?.split(';')[0] ?? null]
  }
  const log = async () => (await db.prepare('SELECT event, grant_id AS grantId, session_sub AS sub, reason FROM access_log ORDER BY id').all()).results
  const redeems = async (id: string) => (await db.prepare('SELECT redeems FROM grants WHERE id = ?').bind(id).first<{ redeems: number }>())!.redeems
  return { gate, page, signIn, mint, step, log, redeems }
}

describe('staff opening a share link', () => {
  it('stay signed in as themselves: the key is dropped, nothing is redeemed, and the card says who', async () => {
    const t = setup()
    const jeff = await t.signIn('jeff@oa.test')
    const { grant, token } = await t.mint()
    expect(await t.step(`/eng-mgr-nyc?key=${token}&ref=dm`, jeff)).toEqual([302, '/eng-mgr-nyc?ref=dm', null])
    const auth = (await t.gate.authenticateResult(t.page('/eng-mgr-nyc', jeff))).auth
    const stats = await d1AuditQuery(db).activity(grant.id)
    expect([auth?.kind === 'sso' ? auth.email : auth, await t.redeems(grant.id), stats.staffClicks, stats.distinctIps]).toEqual([
      'jeff@oa.test', 0, ['jeff@oa.test'], 0,
    ])
    expect((await t.log()).filter(r => r.grantId === grant.id)).toEqual([
      { event: 'mint', grantId: grant.id, sub: 'e:ryan@oa.test', reason: null },
      { event: 'staff-click', grantId: grant.id, sub: 'e:jeff@oa.test', reason: null },
    ])
  })

  it('`?as=recipient`, or `staffKeepSession: false`, redeems as before', async () => {
    const t = setup()
    const jeff = await t.signIn('jeff@oa.test')
    const a = await t.mint()
    const asRecipient = await t.step(`/sre?key=${a.token}&as=recipient`, jeff)
    const off = setup({ staffKeepSession: false })
    const b = await off.mint()
    const [status, location, cookie] = await off.step(`/sre?key=${b.token}`, jeff)
    expect([asRecipient.slice(0, 2), typeof asRecipient[2], [status, location, typeof cookie], await t.redeems(a.grant.id), await t.redeems(b.grant.id)]).toEqual([
      [302, '/sre'], 'string', [302, '/sre', 'string'], 1, 1,
    ])
  })
})

describe('`?key=-`', () => {
  it('ends a link session and lands on the same page without it: logged as a sign-out, no deny row', async () => {
    const t = setup()
    const { grant, token } = await t.mint()
    const [, , link] = await t.step(`/sre?key=${token}`)
    const [status, location, cleared] = await t.step(`/sre?key=${CLEAR_KEY}&tab=2`, link ?? '')
    expect([status, location, cleared, (await t.gate.authenticateResult(t.page('/sre', cleared ?? ''))).auth]).toEqual([
      302, '/sre?tab=2', 'oa_auth=', null,
    ])
    expect((await t.log()).map(r => [r.event, r.sub, r.reason])).toEqual([
      ['mint', 'e:ryan@oa.test', null],
      ['redeem', `g:${grant.id}`, null],
      ['signout', `g:${grant.id}`, 'clear-key'],
    ])
  })

  it('leaves an email sign-in alone, and is no credential to `authenticate`', async () => {
    const t = setup()
    const jeff = await t.signIn('jeff@oa.test')
    const kept = await t.step(`/sre?key=${CLEAR_KEY}`, jeff)
    const bare = await t.gate.authenticateResult(t.page(`/sre?key=${CLEAR_KEY}`))
    expect([kept, [bare.auth, bare.credential], (await t.log()).map(r => r.event)]).toEqual([
      [302, '/sre', null],
      [null, 'none'],
      ['signin'],
    ])
  })
})
