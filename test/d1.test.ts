/** Exercises the adapter's real SQL against the real migrations. */
import { beforeEach, describe, expect, it } from 'vitest'
import { d1AuditSink, d1GrantStore } from '../src/adapters/d1.js'
import type { AuditSink } from '../src/core/audit.js'
import { createGate } from '../src/core/gate.js'
import type { GrantStore } from '../src/core/store.js'
import type { Grant } from '../src/core/types.js'
import { testDb } from './d1-shim.js'

const SECRET = 'test-secret-0123456789abcdef'
const NOW = Date.parse('2026-08-16T00:00:00Z')
const NOW_S = NOW / 1000

let db: D1Database
let store: GrantStore
let audit: AuditSink

const gate = () => createGate({ store, secret: SECRET, audit, adminEmails: ['boss@openathena.ai'] })
const req = (path = '/dash') => new Request(`https://x.test${path}`)

const rows = async <T>(sql: string): Promise<T[]> => (await db.prepare(sql).all<T>()).results

beforeEach(() => {
  db = testDb()
  store = d1GrantStore(db)
  audit = d1AuditSink(db)
})

describe('grant round-trip', () => {
  it('preserves every column, including the subject blob and scope list', async () => {
    const { grant } = await gate().mint(
      {
        name: 'Bob Smith (donor)',
        note: 'Q3 board packet',
        subject: { first: 'Bob', last: 'Smith', email: 'bob@example.com' },
        email: 'bob@example.com',
        scopes: ['reports', 'finances'],
        maxRedeems: 3,
        expiresAt: NOW_S + 86400,
        sessionTtlS: 7200,
        createdBy: 'boss@openathena.ai',
      },
      NOW,
    )
    expect(await store.byId(grant.id)).toEqual(grant)
  })

  it('lists newest-first and hides revoked grants unless asked', async () => {
    const g = gate()
    const a = await g.mint({ scopes: ['x'], name: 'a', createdBy: 'boss@openathena.ai' }, NOW)
    const b = await g.mint({ scopes: ['x'], name: 'b', createdBy: 'boss@openathena.ai' }, NOW + 1000)
    await g.revoke(a.grant.id, NOW + 2000)
    expect((await store.list()).map(x => x.name)).toEqual(['b'])
    expect((await store.list({ includeRevoked: true })).map(x => x.name)).toEqual(['b', 'a'])
  })

  it('survives a malformed subject blob rather than failing the auth path', async () => {
    const { grant } = await gate().mint({ scopes: ['x'], createdBy: 'boss@openathena.ai' }, NOW)
    await db.prepare(`UPDATE grants SET subject_json = ? WHERE id = ?`).bind('{not json', grant.id).run()
    expect((await store.byId(grant.id))!.subject).toBe(null)
  })
})

describe('redeem is an atomic compare-and-swap', () => {
  // node:sqlite is synchronous, so these run serially rather than truly racing;
  // what this pins is that the cap guard lives in the UPDATE's WHERE clause, so
  // no read-then-write window exists for a real D1 to race through.
  it('lets exactly one of many opens through a max_redeems: 1 link', async () => {
    const { grant } = await gate().mint({ scopes: ['x'], maxRedeems: 1, createdBy: 'boss@openathena.ai' }, NOW)
    const attempts = await Promise.all(Array.from({ length: 8 }, () => store.redeem(grant.id, NOW_S)))
    expect(attempts.filter(Boolean).length).toBe(1)
    expect((await store.byId(grant.id))!.redeems).toBe(1)
  })

  it('stamps first_used_at once and last_used_at every time', async () => {
    const { grant } = await gate().mint({ scopes: ['x'], createdBy: 'boss@openathena.ai' }, NOW)
    await store.redeem(grant.id, NOW_S)
    await store.redeem(grant.id, NOW_S + 500)
    const after = (await store.byId(grant.id))!
    expect([after.redeems, after.firstUsedAt, after.lastUsedAt]).toEqual([2, NOW_S, NOW_S + 500])
  })

  it('refuses expired and revoked grants without incrementing the counter', async () => {
    const g = gate()
    const expired = await g.mint({ scopes: ['x'], expiresAt: NOW_S - 1, createdBy: 'boss@openathena.ai' }, NOW)
    const revoked = await g.mint({ scopes: ['x'], createdBy: 'boss@openathena.ai' }, NOW)
    await g.revoke(revoked.grant.id, NOW)
    expect([await store.redeem(expired.grant.id, NOW_S), await store.redeem(revoked.grant.id, NOW_S)]).toEqual([null, null])
    expect([(await store.byId(expired.grant.id))!.redeems, (await store.byId(revoked.grant.id))!.redeems]).toEqual([0, 0])
  })
})

describe('touch', () => {
  it('only writes once per interval', async () => {
    const { grant } = await gate().mint({ scopes: ['x'], createdBy: 'boss@openathena.ai' }, NOW)
    await store.touch(grant.id, NOW_S, 60)
    await store.touch(grant.id, NOW_S + 30, 60)
    expect((await store.byId(grant.id))!.lastUsedAt).toBe(NOW_S)
    await store.touch(grant.id, NOW_S + 61, 60)
    expect((await store.byId(grant.id))!.lastUsedAt).toBe(NOW_S + 61)
  })
})

describe('revoke', () => {
  it('reports whether it changed anything', async () => {
    const { grant } = await gate().mint({ scopes: ['x'], createdBy: 'boss@openathena.ai' }, NOW)
    expect([await store.revoke(grant.id, NOW_S), await store.revoke(grant.id, NOW_S), await store.revoke('nope', NOW_S)]).toEqual([
      true,
      false,
      false,
    ])
  })
})

describe('access log', () => {
  interface LogRow {
    event: string
    grant_id: string | null
    session_sub: string | null
    path: string | null
    reason: string | null
    ip_hash: string | null
    country: string | null
    bucket: number | null
  }
  const logRows = () =>
    rows<LogRow>('SELECT event, grant_id, session_sub, path, reason, ip_hash, country, bucket FROM access_log ORDER BY id')

  it('records the lifecycle of a link', async () => {
    const g = gate()
    const { grant, token } = await g.mint({ scopes: ['x'], createdBy: 'boss@openathena.ai' }, NOW)
    await g.redeem(token, req('/r'), NOW)
    await g.redeem('bogus', req('/r'), NOW)
    await g.revoke(grant.id, NOW)
    await g.authenticate(new Request(`https://x.test/api?key=${token}`), NOW)

    expect((await logRows()).map(r => [r.event, r.grant_id, r.path, r.reason])).toEqual([
      ['redeem', grant.id, '/r', null],
      ['deny', null, '/r', 'bad-token'],
      ['revoke', grant.id, null, null],
      ['deny', grant.id, '/api', 'revoked'],
    ])
  })

  it('hashes the client IP instead of storing it, and keeps CF country', async () => {
    const g = gate()
    const { token } = await g.mint({ scopes: ['x'], createdBy: 'boss@openathena.ai' }, NOW)
    await g.redeem(
      token,
      new Request('https://x.test/r', { headers: { 'CF-Connecting-IP': '203.0.113.7', 'CF-IPCountry': 'US' } }),
      NOW,
    )
    const [row] = await logRows()
    expect(row!.ip_hash).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(row!.country).toBe('US')
    expect(await rows<{ n: number }>(`SELECT COUNT(*) AS n FROM access_log WHERE ip_hash LIKE '%203.0.113.7%'`)).toEqual([
      { n: 0 },
    ])
  })

  it('dedupes view rows per session/path/hour but keeps distinct paths and hours', async () => {
    const sub = 'e:staff@openathena.ai'
    const view = (path: string, ts: number) => audit.log({ ts, event: 'view', sessionSub: sub, path })
    await view('/finances', NOW_S)
    await view('/finances', NOW_S + 60)
    await view('/finances', NOW_S + 3601)
    await view('/board', NOW_S)

    expect((await logRows()).map(r => [r.path, r.bucket])).toEqual([
      ['/finances', Math.floor(NOW_S / 3600)],
      ['/finances', Math.floor((NOW_S + 3601) / 3600)],
      ['/board', Math.floor(NOW_S / 3600)],
    ])
  })

  it('never dedupes lifecycle events, even identical ones', async () => {
    const e = { ts: NOW_S, event: 'redeem' as const, grantId: 'g1', sessionSub: 'g:g1', path: '/r' }
    await audit.log(e)
    await audit.log(e)
    expect((await logRows()).map(r => [r.event, r.bucket])).toEqual([
      ['redeem', null],
      ['redeem', null],
    ])
  })
})
