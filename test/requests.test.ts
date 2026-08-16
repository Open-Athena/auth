import { beforeEach, describe, expect, it } from 'vitest'
import { d1AuditSink, d1GrantStore, d1RequestStore } from '../src/adapters/d1.js'
import { createGate } from '../src/core/gate.js'
import { domainPolicy } from '../src/core/policy.js'
import { isEmailish, type NotifyEvent } from '../src/core/requests.js'
import { testDb } from './d1-shim.js'

const SECRET = 'test-secret-0123456789abcdef'
const NOW = Date.parse('2026-08-16T00:00:00Z')
const NOW_S = NOW / 1000

let db: D1Database
let sent: NotifyEvent[]

const gate = (extra: Partial<Parameters<typeof createGate>[0]> = {}) =>
  createGate({
    store: d1GrantStore(db),
    requests: d1RequestStore(db),
    audit: d1AuditSink(db),
    notify: async e => void sent.push(e),
    secret: SECRET,
    adminEmails: ['boss@openathena.ai'],
    policy: domainPolicy(['openathena.ai'], ['internal']),
    approvalGrant: { scopes: ['reports'], expiresInS: 30 * 86400 },
    ...extra,
  })

const req = (ip = '203.0.113.7') => new Request('https://x.test/request', { headers: { 'CF-Connecting-IP': ip } })

/** Notification kinds + the address each went to — the part a test cares about. */
const notified = () => sent.map(e => [e.kind, e.request.email] as const)

beforeEach(() => {
  db = testDb()
  sent = []
})

describe('isEmailish', () => {
  it('accepts real-world addresses and rejects obvious non-addresses', () => {
    const cases = ['a@b.co', 'first.last+tag@sub.example.org', "o'brien@example.com", 'no-at-sign', 'a@b', 'a b@c.com', '@b.com', 'a@.com']
    expect(cases.map(isEmailish)).toEqual([true, true, true, false, false, false, false, false])
  })
})

describe('requestAccess', () => {
  it('queues a pending request and notifies an admin', async () => {
    const res = await gate().requestAccess({ email: 'Bob@Example.com', name: 'Bob', note: 'donor' }, req(), NOW)
    expect(res.status).toBe('pending')
    if (res.status !== 'pending') throw new Error('expected pending')
    expect(res.request).toEqual({
      id: expect.stringMatching(/^[A-Za-z0-9_-]{12}$/),
      email: 'bob@example.com', // normalized
      name: 'Bob',
      note: 'donor',
      createdAt: NOW_S,
      status: 'pending',
      decidedAt: null,
      decidedBy: null,
      grantId: null,
    })
    expect(notified()).toEqual([['access-requested', 'bob@example.com']])
  })

  it('auto-approves a policy match and delivers the link in one step', async () => {
    const res = await gate().requestAccess({ email: 'staff@openathena.ai' }, req(), NOW)
    if (res.status !== 'auto') throw new Error(`expected auto, got ${res.status}`)
    expect([res.request.status, res.request.decidedBy, res.request.grantId]).toEqual(['auto', 'policy', res.grant.id])
    expect(res.grant.email).toBe('staff@openathena.ai')
    expect(res.grant.scopes).toEqual(['internal']) // the policy's scopes, not approvalGrant's
    expect(res.grant.expiresAt).toBe(NOW_S + 30 * 86400)
    expect(notified()).toEqual([['access-granted', 'staff@openathena.ai']])
  })

  it('mints a working link on auto-approval', async () => {
    const g = gate()
    const res = await g.requestAccess({ email: 'staff@openathena.ai' }, req(), NOW)
    if (res.status !== 'auto') throw new Error('expected auto')
    const redeemed = await g.redeem(res.token, req(), NOW)
    expect(redeemed.ok).toBe(true)
  })

  it('is idempotent for a re-visit: one row, one notification', async () => {
    const g = gate()
    const first = await g.requestAccess({ email: 'bob@example.com' }, req(), NOW)
    const second = await g.requestAccess({ email: 'bob@example.com', note: 'again' }, req(), NOW + 1000)
    if (first.status !== 'pending' || second.status !== 'pending') throw new Error('expected pending')
    expect(second.request.id).toBe(first.request.id)
    expect(second.request.note).toBe(null) // the original row, not the resubmit
    expect(notified()).toEqual([['access-requested', 'bob@example.com']])
    expect((await g.listRequests()).length).toBe(1)
  })

  it('rejects malformed addresses without storing or notifying', async () => {
    const g = gate()
    expect(await g.requestAccess({ email: 'not-an-email' }, req(), NOW)).toEqual({ status: 'invalid' })
    expect(await g.listRequests()).toEqual([])
    expect(sent).toEqual([])
  })

  it('rate-limits per email', async () => {
    const g = gate({ rateLimit: { perEmail: 2, windowS: 3600 } })
    // Decide each one so the next isn't short-circuited as a duplicate pending.
    for (const i of [0, 1]) {
      const res = await g.requestAccess({ email: 'bob@example.com' }, req(), NOW + i * 1000)
      if (res.status !== 'pending') throw new Error('expected pending')
      await g.denyRequest(res.request.id, 'boss@openathena.ai', NOW + i * 1000)
    }
    expect(await g.requestAccess({ email: 'bob@example.com' }, req(), NOW + 2000)).toEqual({ status: 'rate-limited' })
  })

  it('rate-limits per IP across different addresses', async () => {
    const g = gate({ rateLimit: { perIp: 2, windowS: 3600 } })
    await g.requestAccess({ email: 'a@example.com' }, req(), NOW)
    await g.requestAccess({ email: 'b@example.com' }, req(), NOW)
    expect(await g.requestAccess({ email: 'c@example.com' }, req(), NOW)).toEqual({ status: 'rate-limited' })
    // A different client is unaffected.
    expect((await g.requestAccess({ email: 'd@example.com' }, req('198.51.100.4'), NOW)).status).toBe('pending')
  })

  it('lets the window expire', async () => {
    const g = gate({ rateLimit: { perIp: 1, windowS: 3600 } })
    await g.requestAccess({ email: 'a@example.com' }, req(), NOW)
    expect((await g.requestAccess({ email: 'b@example.com' }, req(), NOW)).status).toBe('rate-limited')
    expect((await g.requestAccess({ email: 'b@example.com' }, req(), NOW + 3601_000)).status).toBe('pending')
  })

  it('throws a useful error when request-access is not configured', async () => {
    const g = createGate({ store: d1GrantStore(db), secret: SECRET })
    await expect(g.requestAccess({ email: 'a@b.com' }, req(), NOW)).rejects.toThrow(
      'request-access is not configured: pass `requests` to createGate',
    )
  })
})

describe('approveRequest', () => {
  it('mints a grant bound to the requester and delivers it', async () => {
    const g = gate()
    const pending = await g.requestAccess({ email: 'bob@example.com', name: 'Bob' }, req(), NOW)
    if (pending.status !== 'pending') throw new Error('expected pending')
    sent.length = 0

    const res = await g.approveRequest(pending.request.id, 'boss@openathena.ai', {}, NOW + 1000)
    if (!res) throw new Error('expected approval to succeed')
    expect([res.request.status, res.request.decidedBy, res.request.decidedAt]).toEqual([
      'approved',
      'boss@openathena.ai',
      NOW_S + 1,
    ])
    expect([res.grant.email, res.grant.name, res.grant.scopes]).toEqual(['bob@example.com', 'Bob', ['reports']])
    expect(res.request.grantId).toBe(res.grant.id)
    expect(notified()).toEqual([['access-granted', 'bob@example.com']])

    const redeemed = await g.redeem(res.token, req(), NOW + 2000)
    expect(redeemed.ok).toBe(true)
  })

  it('honours a scope override', async () => {
    const g = gate()
    const pending = await g.requestAccess({ email: 'bob@example.com' }, req(), NOW)
    if (pending.status !== 'pending') throw new Error('expected pending')
    const res = await g.approveRequest(pending.request.id, 'boss@openathena.ai', { scopes: ['finances'] }, NOW)
    expect(res!.grant.scopes).toEqual(['finances'])
  })

  it('decides once: a second approve is a no-op that mints nothing', async () => {
    const g = gate()
    const pending = await g.requestAccess({ email: 'bob@example.com' }, req(), NOW)
    if (pending.status !== 'pending') throw new Error('expected pending')
    const first = await g.approveRequest(pending.request.id, 'boss@openathena.ai', {}, NOW)
    const second = await g.approveRequest(pending.request.id, 'other@openathena.ai', {}, NOW)
    expect([first !== null, second]).toEqual([true, null])
    expect((await g.list({ includeRevoked: true })).length).toBe(1)
  })

  it('mints nothing for an already-denied request', async () => {
    const g = gate()
    const pending = await g.requestAccess({ email: 'bob@example.com' }, req(), NOW)
    if (pending.status !== 'pending') throw new Error('expected pending')
    await g.denyRequest(pending.request.id, 'boss@openathena.ai', NOW)
    sent.length = 0

    expect(await g.approveRequest(pending.request.id, 'other@openathena.ai', {}, NOW)).toBe(null)
    expect(await g.list({ includeRevoked: true })).toEqual([])
    expect(sent).toEqual([])
  })

  it('revokes the grant it minted if it loses the decide race', async () => {
    // The status re-check above is read-then-write, so a second admin can still
    // win in between. When the guarded UPDATE comes back empty, the grant that
    // was already minted must not be left usable.
    const requests = d1RequestStore(db)
    const g = gate({ requests: { ...requests, decide: async () => null } })
    const pending = await g.requestAccess({ email: 'bob@example.com' }, req(), NOW)
    if (pending.status !== 'pending') throw new Error('expected pending')
    sent.length = 0

    expect(await g.approveRequest(pending.request.id, 'boss@openathena.ai', {}, NOW)).toBe(null)
    expect((await g.list({ includeRevoked: true })).map(x => x.revokedAt !== null)).toEqual([true])
    expect(await g.list()).toEqual([]) // nothing active
    expect(sent).toEqual([])
  })

  it('returns null for an unknown id', async () => {
    expect(await gate().approveRequest('nope', 'boss@openathena.ai', {}, NOW)).toBe(null)
  })
})

describe('denyRequest', () => {
  it('records the decision and notifies', async () => {
    const g = gate()
    const pending = await g.requestAccess({ email: 'bob@example.com' }, req(), NOW)
    if (pending.status !== 'pending') throw new Error('expected pending')
    sent.length = 0

    const denied = await g.denyRequest(pending.request.id, 'boss@openathena.ai', NOW + 1000)
    expect([denied!.status, denied!.decidedBy, denied!.grantId]).toEqual(['denied', 'boss@openathena.ai', null])
    expect(notified()).toEqual([['access-denied', 'bob@example.com']])
    expect(await g.denyRequest(pending.request.id, 'boss@openathena.ai', NOW + 2000)).toBe(null)
  })
})

describe('listRequests', () => {
  it('filters by status, newest first', async () => {
    const g = gate()
    const a = await g.requestAccess({ email: 'a@example.com' }, req(), NOW)
    await g.requestAccess({ email: 'b@example.com' }, req(), NOW + 1000)
    if (a.status !== 'pending') throw new Error('expected pending')
    await g.denyRequest(a.request.id, 'boss@openathena.ai', NOW + 2000)

    expect((await g.listRequests()).map(r => [r.email, r.status])).toEqual([
      ['b@example.com', 'pending'],
      ['a@example.com', 'denied'],
    ])
    expect((await g.listRequests({ status: 'pending' })).map(r => r.email)).toEqual(['b@example.com'])
  })
})
