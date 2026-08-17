import { beforeEach, describe, expect, it } from 'vitest'
import { createGate, isActive } from '../src/core/gate.js'
import { domainPolicy } from '../src/core/policy.js'
import { hasScope } from '../src/core/types.js'
import { type MemoryAudit, type MemoryStore, logged, memoryAudit, memoryStore } from './memory-store.js'

const SECRET = 'test-secret-0123456789abcdef'
const NOW = Date.parse('2026-08-16T00:00:00Z')
const NOW_S = NOW / 1000
const DAY = 24 * 3600 * 1000

let store: MemoryStore
let audit: MemoryAudit

const gate = (extra: Partial<Parameters<typeof createGate>[0]> = {}) =>
  createGate({
    store,
    secret: SECRET,
    audit,
    adminEmails: ['boss@openathena.ai'],
    policy: domainPolicy(['openathena.ai'], ['internal']),
    ...extra,
  })

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0 Safari/537.36'

const req = (path = '/dash', init: RequestInit = {}) =>
  new Request(`https://x.test${path}`, { ...init, headers: { 'User-Agent': UA, ...(init.headers as Record<string, string>) } })
const withCookie = (cookie: string, path = '/dash') => req(path, { headers: { Cookie: cookie } })

/** `name=value` out of a Set-Cookie string. */
const cookiePair = (setCookie: string): string => setCookie.split(';')[0]!
const maxAge = (setCookie: string): number => Number(/Max-Age=(\d+)/.exec(setCookie)![1])

beforeEach(() => {
  store = memoryStore()
  audit = memoryAudit()
})

describe('mint', () => {
  it('returns the raw token once and stores only its hash', async () => {
    const { grant, token } = await gate().mint({ scopes: ['internal'], name: 'Bob Smith', createdBy: 'boss@openathena.ai' }, NOW)
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/)
    expect(grant).toEqual({
      id: expect.stringMatching(/^[A-Za-z0-9_-]{12}$/),
      name: 'Bob Smith',
      note: null,
      subject: null,
      email: null,
      scopes: ['internal'],
      maxRedeems: null,
      redeems: 0,
      expiresAt: null,
      sessionTtlS: null,
      createdAt: NOW_S,
      createdBy: 'boss@openathena.ai',
      revokedAt: null,
      firstUsedAt: null,
      lastUsedAt: null,
    })
    expect([...store.hashes.keys()]).not.toContain(token)
  })

  it('zero-config is an unlimited, never-expiring link', async () => {
    const { grant } = await gate().mint({ scopes: ['internal'], createdBy: 'boss@openathena.ai' }, NOW)
    expect([grant.maxRedeems, grant.expiresAt, grant.sessionTtlS, grant.name]).toEqual([null, null, null, null])
  })
})

describe('redeem', () => {
  it('mints a session cookie, counts one redemption, and logs it', async () => {
    const g = gate()
    const { grant, token } = await g.mint({ scopes: ['internal'], createdBy: 'boss@openathena.ai' }, NOW)
    const res = await g.redeem(token, req('/r'), NOW)
    if (!res.ok) throw new Error(`expected redeem to succeed, got ${res.reason}`)

    expect([res.grant.redeems, res.grant.firstUsedAt, res.grant.lastUsedAt]).toEqual([1, NOW_S, NOW_S])
    expect(res.cookie).toMatch(/^oa_auth=[\w-]+\.[\w-]+; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=2592000$/)
    expect(logged(audit.events)).toEqual([
      { event: 'mint', grantId: grant.id, sessionSub: 'e:boss@openathena.ai', path: null, reason: null },
      { event: 'redeem', grantId: grant.id, sessionSub: `g:${grant.id}`, path: '/r', reason: null },
    ])
  })

  it('counts sessions, not requests: two opens on one uncapped link are two redemptions', async () => {
    const g = gate()
    const { grant, token } = await g.mint({ scopes: ['internal'], createdBy: 'boss@openathena.ai' }, NOW)
    await g.redeem(token, req(), NOW)
    await g.redeem(token, req(), NOW + 1000)
    expect(store.rows.get(grant.id)!.redeems).toBe(2)
  })

  it('stops at max_redeems and reports it as exhausted', async () => {
    const g = gate()
    const { grant, token } = await g.mint({ scopes: ['internal'], maxRedeems: 1, createdBy: 'boss@openathena.ai' }, NOW)
    const first = await g.redeem(token, req(), NOW)
    const second = await g.redeem(token, req(), NOW)
    expect([first.ok, second.ok]).toEqual([true, false])
    expect(second).toEqual({ ok: false, reason: 'exhausted' })
    expect(store.rows.get(grant.id)!.redeems).toBe(1)
  })

  it('rejects unknown, expired and revoked tokens with distinct reasons', async () => {
    const g = gate()
    const expired = await g.mint({ scopes: ['internal'], expiresAt: NOW_S - 1, createdBy: 'boss@openathena.ai' }, NOW)
    const revoked = await g.mint({ scopes: ['internal'], createdBy: 'boss@openathena.ai' }, NOW)
    await g.revoke(revoked.grant.id, NOW)
    audit.events.length = 0

    const results = await Promise.all([
      g.redeem('not-a-real-token', req('/a'), NOW),
      g.redeem(expired.token, req('/b'), NOW),
      g.redeem(revoked.token, req('/c'), NOW),
    ])
    expect(results).toEqual([
      { ok: false, reason: 'bad-token' },
      { ok: false, reason: 'expired' },
      { ok: false, reason: 'revoked' },
    ])
    expect(logged(audit.events).map(e => [e.event, e.path, e.reason])).toEqual([
      ['deny', '/a', 'bad-token'],
      ['deny', '/b', 'expired'],
      ['deny', '/c', 'revoked'],
    ])
  })

  it('uses the grant session_ttl for the cookie when set', async () => {
    const g = gate()
    const { token } = await g.mint({ scopes: ['internal'], sessionTtlS: 3600, createdBy: 'boss@openathena.ai' }, NOW)
    const res = await g.redeem(token, req(), NOW)
    if (!res.ok) throw new Error('expected redeem to succeed')
    expect(maxAge(res.cookie)).toBe(3600)
  })

  it('drops Secure on a plain-http origin', async () => {
    const g = gate()
    const { token } = await g.mint({ scopes: ['internal'], createdBy: 'boss@openathena.ai' }, NOW)
    const res = await g.redeem(token, new Request('http://localhost:3456/', { headers: { 'User-Agent': UA } }), NOW)
    if (!res.ok) throw new Error('expected redeem to succeed')
    expect(res.cookie).toBe(cookiePair(res.cookie) + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000')
  })
})

describe('authenticate — grant sessions', () => {
  it('resolves a redeemed cookie back to its grant', async () => {
    const g = gate()
    const { grant, token } = await g.mint({ scopes: ['reports'], name: 'Bob', createdBy: 'boss@openathena.ai' }, NOW)
    const res = await g.redeem(token, req(), NOW)
    if (!res.ok) throw new Error('expected redeem to succeed')

    const auth = await g.authenticate(withCookie(cookiePair(res.cookie)), NOW + 1000)
    expect(auth?.kind).toBe('grant')
    expect(g.whoami(auth!)).toEqual({
      kind: 'grant',
      name: 'Bob',
      subject: null,
      email: null,
      scopes: ['reports'],
      admin: false,
      expiresAt: null,
    })
    expect(hasScope(auth!, 'reports')).toBe(true)
    expect(hasScope(auth!, 'admin')).toBe(false)
    expect(store.rows.get(grant.id)!.redeems).toBe(1) // re-use is not a new redemption
  })

  it('revocation is instant: an already-minted session stops working', async () => {
    const g = gate()
    const { grant, token } = await g.mint({ scopes: ['internal'], createdBy: 'boss@openathena.ai' }, NOW)
    const res = await g.redeem(token, req(), NOW)
    if (!res.ok) throw new Error('expected redeem to succeed')
    const cookie = cookiePair(res.cookie)

    expect((await g.authenticate(withCookie(cookie), NOW))?.kind).toBe('grant')
    await g.revoke(grant.id, NOW + 1000)
    expect(await g.authenticate(withCookie(cookie), NOW + 2000)).toBe(null)

    expect(logged(audit.events).map(e => [e.event, e.reason])).toEqual([
      ['mint', null],
      ['redeem', null],
      ['revoke', null],
      ['deny', 'revoked'],
    ])
  })

  it('grant expiry outlives the cookie ttl: the session stops at expires_at', async () => {
    const g = gate()
    const { token } = await g.mint(
      { scopes: ['internal'], expiresAt: NOW_S + 3600, sessionTtlS: 30 * 24 * 3600, createdBy: 'boss@openathena.ai' },
      NOW,
    )
    const res = await g.redeem(token, req(), NOW)
    if (!res.ok) throw new Error('expected redeem to succeed')
    const cookie = cookiePair(res.cookie)

    expect((await g.authenticate(withCookie(cookie), NOW + 3599_000))?.kind).toBe('grant')
    expect(await g.authenticate(withCookie(cookie), NOW + 3601_000)).toBe(null)
  })

  it('rejects a session for a grant that no longer exists', async () => {
    const g = gate()
    const { grant, token } = await g.mint({ scopes: ['internal'], createdBy: 'boss@openathena.ai' }, NOW)
    const res = await g.redeem(token, req(), NOW)
    if (!res.ok) throw new Error('expected redeem to succeed')
    store.rows.delete(grant.id)
    expect(await g.authenticate(withCookie(cookiePair(res.cookie)), NOW)).toBe(null)
  })
})

describe('authenticate — script credentials', () => {
  it('accepts Bearer and ?key= without spending a redemption', async () => {
    const g = gate()
    const { grant, token } = await g.mint({ scopes: ['internal'], createdBy: 'boss@openathena.ai' }, NOW)

    const viaBearer = await g.authenticate(req('/api', { headers: { Authorization: `Bearer ${token}` } }), NOW)
    const viaKey = await g.authenticate(req(`/api?key=${token}`), NOW)
    expect([viaBearer?.kind, viaKey?.kind]).toEqual(['grant', 'grant'])
    expect(store.rows.get(grant.id)!.redeems).toBe(0)
    expect(store.rows.get(grant.id)!.lastUsedAt).toBe(NOW_S)
  })

  it('denies revoked and unknown tokens', async () => {
    const g = gate()
    const { grant, token } = await g.mint({ scopes: ['internal'], createdBy: 'boss@openathena.ai' }, NOW)
    await g.revoke(grant.id, NOW)
    audit.events.length = 0

    expect(await g.authenticate(req(`/api?key=${token}`), NOW)).toBe(null)
    expect(await g.authenticate(req('/api?key=nope'), NOW)).toBe(null)
    expect(logged(audit.events).map(e => [e.event, e.grantId, e.reason])).toEqual([
      ['deny', grant.id, 'revoked'],
      ['deny', null, 'bad-token'],
    ])
  })
})

describe('authenticate — SSO sessions', () => {
  it('signs in a policy-matched email and resolves its cookie', async () => {
    const g = gate()
    const signedIn = await g.signIn('staff@openathena.ai', req('/auth/sso'), NOW)
    expect(signedIn?.auth).toEqual({ kind: 'sso', email: 'staff@openathena.ai', admin: false, scopes: ['internal'] })

    const auth = await g.authenticate(withCookie(cookiePair(signedIn!.cookie)), NOW)
    expect(g.whoami(auth!)).toEqual({ kind: 'sso', email: 'staff@openathena.ai', admin: false, scopes: ['internal'] })
  })

  it('gives admins the wildcard scope, which satisfies every check', async () => {
    const signedIn = await gate().signIn('boss@openathena.ai', req(), NOW)
    expect(signedIn?.auth).toEqual({ kind: 'sso', email: 'boss@openathena.ai', admin: true, scopes: ['*'] })
    expect(hasScope(signedIn!.auth, 'anything-at-all')).toBe(true)
  })

  it('refuses to sign in an identity the policy rejects', async () => {
    const g = gate()
    expect(await g.signIn('stranger@example.com', req('/auth/sso'), NOW)).toBe(null)
    expect(logged(audit.events)).toEqual([
      { event: 'deny', grantId: null, sessionSub: 'e:stranger@example.com', path: '/auth/sso', reason: 'not-allowed' },
    ])
  })

  it('re-checks policy per request, so removing a domain kills live sessions', async () => {
    const signedIn = await gate().signIn('staff@openathena.ai', req(), NOW)
    const cookie = cookiePair(signedIn!.cookie)
    // Same secret, narrower policy — the cookie is still well-formed, but unauthorized.
    const narrowed = gate({ policy: domainPolicy(['other.test'], ['internal']) })
    expect(await narrowed.authenticate(withCookie(cookie), NOW)).toBe(null)
  })

  it('defaults to admins-only when no policy is supplied', async () => {
    const g = createGate({ store, secret: SECRET, audit, adminEmails: ['boss@openathena.ai'] })
    expect((await g.signIn('boss@openathena.ai', req(), NOW))?.auth.scopes).toEqual(['*'])
    expect(await g.signIn('staff@openathena.ai', req(), NOW)).toBe(null)
  })

  it('ignores an expired or unsigned cookie without logging a denial', async () => {
    const g = gate()
    const signedIn = await g.signIn('staff@openathena.ai', req(), NOW)
    audit.events.length = 0
    const results = await Promise.all([
      g.authenticate(withCookie(cookiePair(signedIn!.cookie)), NOW + 31 * DAY),
      g.authenticate(withCookie('oa_auth=garbage'), NOW),
      g.authenticate(req(), NOW),
    ])
    expect(results).toEqual([null, null, null])
    expect(logged(audit.events)).toEqual([])
  })
})

describe('signOut', () => {
  it('clears the cookie and logs the subject', async () => {
    const g = gate()
    const signedIn = await g.signIn('staff@openathena.ai', req(), NOW)
    audit.events.length = 0
    expect(await g.signOut(req('/auth/logout'), signedIn!.auth, NOW)).toBe(
      'oa_auth=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0',
    )
    expect(logged(audit.events)).toEqual([
      { event: 'signout', grantId: null, sessionSub: 'e:staff@openathena.ai', path: '/auth/logout', reason: null },
    ])
  })
})

describe('revoke', () => {
  it('is idempotent and only logs the effective call', async () => {
    const g = gate()
    const { grant } = await g.mint({ scopes: ['internal'], createdBy: 'boss@openathena.ai' }, NOW)
    expect([await g.revoke(grant.id, NOW), await g.revoke(grant.id, NOW + 1000)]).toEqual([true, false])
    expect(await g.revoke('no-such-grant', NOW)).toBe(false)
    expect(logged(audit.events).map(e => [e.event, e.grantId])).toEqual([
      ['mint', grant.id],
      ['revoke', grant.id],
    ])
  })
})

describe('view logging', () => {
  it('is off by default', async () => {
    const g = gate()
    const signedIn = await g.signIn('staff@openathena.ai', req(), NOW)
    audit.events.length = 0
    await g.authenticate(withCookie(cookiePair(signedIn!.cookie), '/finances/2025'), NOW)
    expect(logged(audit.events)).toEqual([])
  })

  it('emits a view per authenticated request when enabled', async () => {
    const g = gate({ logViews: true })
    const signedIn = await g.signIn('staff@openathena.ai', req(), NOW)
    audit.events.length = 0
    await g.authenticate(withCookie(cookiePair(signedIn!.cookie), '/finances/2025'), NOW)
    expect(logged(audit.events)).toEqual([
      { event: 'view', grantId: null, sessionSub: 'e:staff@openathena.ai', path: '/finances/2025', reason: null },
    ])
  })
})

describe('touch', () => {
  it('skips redundant last_used_at writes inside the interval', async () => {
    const g = gate({ touchIntervalS: 60 })
    const { grant, token } = await g.mint({ scopes: ['internal'], createdBy: 'boss@openathena.ai' }, NOW)
    await g.authenticate(req(`/a?key=${token}`), NOW)
    await g.authenticate(req(`/b?key=${token}`), NOW + 30_000)
    expect(store.rows.get(grant.id)!.lastUsedAt).toBe(NOW_S)
    await g.authenticate(req(`/c?key=${token}`), NOW + 61_000)
    expect(store.rows.get(grant.id)!.lastUsedAt).toBe(NOW_S + 61)
  })
})

describe('isActive', () => {
  it('ignores redemption caps — those are spent at redeem time only', () => {
    const base = {
      id: 'x',
      name: null,
      note: null,
      subject: null,
      email: null,
      scopes: ['internal'],
      redeems: 5,
      maxRedeems: 1,
      sessionTtlS: null,
      createdAt: NOW_S,
      createdBy: 'boss@openathena.ai',
      firstUsedAt: null,
      lastUsedAt: null,
    }
    expect([
      isActive({ ...base, expiresAt: null, revokedAt: null }, NOW_S),
      isActive({ ...base, expiresAt: NOW_S + 1, revokedAt: null }, NOW_S),
      isActive({ ...base, expiresAt: NOW_S, revokedAt: null }, NOW_S),
      isActive({ ...base, expiresAt: null, revokedAt: NOW_S }, NOW_S),
    ]).toEqual([true, true, false, false])
  })
})
