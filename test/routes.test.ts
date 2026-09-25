import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { d1AuditQuery, d1AuditSink, d1GrantStore, d1RequestStore } from '../src/adapters/d1.js'
import { createGate } from '../src/core/gate.js'
import { adminPolicy, anyEmailPolicy, firstMatch } from '../src/core/policy.js'
import { authRoutes } from '../src/core/routes.js'
import type { Auth } from '../src/core/types.js'
import { testDb } from './d1-shim.js'

const SECRET = 'test-secret-0123456789abcdef'
const NOW = Date.parse('2026-08-16T00:00:00Z')

let db: D1Database
let gate: ReturnType<typeof createGate>
let handle: ReturnType<typeof authRoutes>

const url = (path: string) => `https://x.test/api/auth${path}`

const call = async (path: string, init: RequestInit = {}, cookie?: string) => {
  const headers = new Headers(init.headers)
  if (cookie) headers.set('Cookie', cookie)
  if (init.body) headers.set('content-type', 'application/json')
  const res = await handle(new Request(url(path), { ...init, headers }))
  if (!res) throw new Error(`route not handled: ${path}`)
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null, setCookie: res.headers.get('set-cookie') }
}

const post = (path: string, data: unknown, cookie?: string) =>
  call(path, { method: 'POST', body: JSON.stringify(data) }, cookie)

/** `name=value` out of a Set-Cookie string. */
const pair = (setCookie: string) => setCookie.split(';')[0]!

/** Sign in as an admin and return the cookie to send on later calls. */
const asAdmin = async (email = 'boss@openathena.ai') => {
  const res = await gate.signIn(email, new Request('https://x.test/'), NOW)
  return pair(res!.cookie)
}

// Sessions are signed at NOW but `gate.authenticate` verifies against the wall
// clock; without pinning the clock the default 30-day session TTL makes every
// `asAdmin()` cookie expire 30 days after NOW and the suite starts 401ing on a
// fixed calendar date. Fake only `Date` (leave real timers) so signing and
// verification share one instant.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  db = testDb()
  gate = createGate({
    store: d1GrantStore(db),
    requests: d1RequestStore(db),
    audit: d1AuditSink(db),
    secret: SECRET,
    adminEmails: ['boss@openathena.ai'],
    approvalGrant: { scopes: ['reports'] },
  })
  handle = authRoutes(gate, { audit: d1AuditQuery(db) })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('mounting', () => {
  it('ignores paths it does not own, so an app can fall through', async () => {
    expect(await handle(new Request('https://x.test/api/data'))).toBe(null)
    expect(await handle(new Request('https://x.test/api/authorize'))).toBe(null)
  })

  it('404s an unknown path under its own prefix', async () => {
    expect((await call('/nope')).status).toBe(404)
  })

  it('honours a custom basePath', async () => {
    const mounted = authRoutes(gate, { basePath: '/gate' })
    expect(await mounted(new Request(url('/whoami')))).toBe(null)
    expect((await mounted(new Request('https://x.test/gate/whoami')))!.status).toBe(401)
  })
})

describe('whoami', () => {
  it('401s anonymously and reflects the identity once signed in', async () => {
    expect(await call('/whoami')).toMatchObject({ status: 401, body: { error: 'unauthenticated' } })
    const cookie = await asAdmin()
    expect(await call('/whoami', {}, cookie)).toMatchObject({
      status: 200,
      body: { kind: 'sso', email: 'boss@openathena.ai', admin: true, scopes: ['*'], subject: null },
    })
  })

  describe('a dead session cookie', () => {
    const EXPIRED = 'oa_auth=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0'

    it('is cleared when a revoked grant is behind it', async () => {
      const admin = await asAdmin()
      const minted = await post('/grants', { name: 'Bob', scopes: ['reports'] }, admin)
      const session = pair((await post('/exchange', { token: minted.body.token })).setCookie!)
      expect((await call('/whoami', {}, session)).status).toBe(200)
      await post(`/grants/${minted.body.grant.id}/revoke`, {}, admin)
      expect(await call('/whoami', {}, session)).toEqual({ status: 401, body: { error: 'unauthenticated' }, setCookie: EXPIRED })
    })

    it('is cleared when the session itself has expired', async () => {
      const cookie = await asAdmin()
      vi.setSystemTime(NOW + 31 * 24 * 3600 * 1000)
      expect(await call('/whoami', {}, cookie)).toEqual({ status: 401, body: { error: 'unauthenticated' }, setCookie: EXPIRED })
    })

    it('is not touched when no cookie was sent, or when a bad ?key= failed beside a live cookie', async () => {
      expect(await call('/whoami')).toEqual({ status: 401, body: { error: 'unauthenticated' }, setCookie: null })
      const cookie = await asAdmin()
      expect(await call('/whoami?key=bogus', {}, cookie)).toEqual({ status: 401, body: { error: 'unauthenticated' }, setCookie: null })
      expect((await call('/whoami', {}, cookie)).status).toBe(200)
    })
  })
})

describe('exchange', () => {
  it('trades a token for a session cookie', async () => {
    const cookie = await asAdmin()
    const minted = await post('/grants', { name: 'Bob', scopes: ['reports'] }, cookie)
    const res = await post('/exchange', { token: minted.body.token })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      kind: 'grant',
      // The grant id is returned to the recipient: it names the session they
      // are in, and it isn't the secret — the token is.
      id: minted.body.grant.id,
      name: 'Bob',
      subject: null,
      email: null,
      scopes: ['reports'],
      admin: false,
      expiresAt: null,
    })
    expect(res.setCookie).toMatch(/^oa_auth=[\w-]+\.[\w-]+; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=2592000$/)
  })

  it('reports why a bad link failed without minting anything', async () => {
    expect(await post('/exchange', { token: 'nope' })).toMatchObject({
      status: 401,
      body: { error: 'invalid link', reason: 'bad-token' },
      setCookie: null,
    })
    expect(await post('/exchange', {})).toMatchObject({ status: 400, body: { error: 'token required' } })
  })
})

describe('admin routes', () => {
  it('401 anonymously, 403 for a non-admin identity', async () => {
    expect((await call('/grants')).status).toBe(401)

    const g = createGate({ store: d1GrantStore(db), secret: SECRET, policy: anyEmailPolicy(['read']) })
    const nonAdmin = authRoutes(g, {})
    const signedIn = await g.signIn('nobody@example.com', new Request('https://x.test/'), NOW)
    const res = await nonAdmin(new Request(url('/grants'), { headers: { Cookie: pair(signedIn!.cookie) } }))
    expect(res!.status).toBe(403)
  })

  it('mints, lists, and revokes a grant', async () => {
    const cookie = await asAdmin()
    const minted = await post('/grants', { name: 'Bob Smith', scopes: ['reports'], maxRedeems: 3 }, cookie)
    expect(minted.status).toBe(200)
    expect(minted.body.token).toMatch(/^[A-Za-z0-9_-]{32}$/)
    expect(minted.body.grant).toMatchObject({ name: 'Bob Smith', scopes: ['reports'], maxRedeems: 3, redeems: 0 })

    const listed = await call('/grants', {}, cookie)
    expect(listed.body.grants.map((x: { id: string }) => x.id)).toEqual([minted.body.grant.id])

    expect(await post(`/grants/${minted.body.grant.id}/revoke`, {}, cookie)).toMatchObject({ body: { ok: true } })
    // A revoked grant stays in the ledger; `?active=1` is what hides it.
    const [row] = (await call('/grants', {}, cookie)).body.grants as { id: string; revokedAt: number }[]
    const nowS = Math.floor(Date.now() / 1000)
    expect([row!.id, nowS - row!.revokedAt < 10]).toEqual([minted.body.grant.id, true])
    expect((await call('/grants?active=1', {}, cookie)).body.grants).toEqual([])
  })

  it('requires scopes to mint', async () => {
    const cookie = await asAdmin()
    expect(await post('/grants', { name: 'Bob' }, cookie)).toMatchObject({ status: 400, body: { error: 'scopes required' } })
  })
})

describe('mint route: the person on the link', () => {
  it("stores the recipient's name and an https avatar on the grant's subject", async () => {
    const cookie = await asAdmin()
    const minted = await post(
      '/grants',
      { name: 'Q3 packet', scopes: ['reports'], subjectName: 'Bob Smith', avatar: 'https://cdn.test/bob.png' },
      cookie,
    )
    // `name` stays the link's admin-side label; the person is `subject.name`.
    expect([minted.body.grant.name, minted.body.grant.subject]).toEqual([
      'Q3 packet',
      { name: 'Bob Smith', avatar: 'https://cdn.test/bob.png' },
    ])
  })

  it('drops an avatar that is not https, rather than minting a link that loads it', async () => {
    const cookie = await asAdmin()
    const cases = ['http://cdn.test/bob.png', 'javascript:alert(1)', 'data:image/png;base64,AAAA']
    const minted = []
    for (const avatar of cases) {
      const res = await post('/grants', { scopes: ['reports'], subjectName: 'Bob', avatar }, cookie)
      minted.push(res.body.grant.subject)
    }
    expect(minted).toEqual([{ name: 'Bob' }, { name: 'Bob' }, { name: 'Bob' }])
  })

  it('501s the avatar lookup until a deployment opts in', async () => {
    const cookie = await asAdmin()
    expect(await post('/avatar', { email: 'bob@example.com' }, cookie)).toMatchObject({
      status: 501,
      body: { error: 'avatar lookup not configured' },
    })
  })

  it('never lets a non-admin ask it to fetch anything', async () => {
    // Checked *before* the 501, so an anonymous caller can't even discover
    // whether lookup is enabled.
    expect((await post('/avatar', { email: 'bob@example.com' })).status).toBe(401)
  })
})

describe('request-access route', () => {
  it('accepts a submission but never echoes the id back to a stranger', async () => {
    const res = await post('/request', { email: 'bob@example.com', note: 'donor' })
    expect(res).toMatchObject({ status: 200, body: { status: 'pending' } })
    expect(Object.keys(res.body)).toEqual(['status'])
    expect((await gate.listRequests()).map(r => r.email)).toEqual(['bob@example.com'])
  })

  it('takes the name from the form as the subject, and drops everything else the body carries', async () => {
    await post('/request', {
      email: 'bob@example.com',
      name: 'Bob Smith',
      // Neither of these is a field the form offers, and neither may reach an
      // admin's screen: `avatar` would render as <img src> on the request table.
      avatar: 'https://evil.test/pixel.gif',
      admin: true,
    })
    expect((await gate.listRequests()).map(r => [r.email, r.name, r.subject])).toEqual([
      ['bob@example.com', 'Bob Smith', { name: 'Bob Smith' }],
    ])
  })

  it('swallows a honeypot submission silently, storing nothing', async () => {
    expect(await post('/request', { email: 'bot@example.com', website: 'http://spam' })).toMatchObject({
      status: 200,
      body: { status: 'pending' },
    })
    expect(await gate.listRequests()).toEqual([])
  })

  it('reports invalid addresses and rate limits with usable status codes', async () => {
    expect((await post('/request', { email: 'nope' })).status).toBe(400)
    expect((await post('/request', {})).status).toBe(400)
  })

  it('approves through to a working link', async () => {
    const cookie = await asAdmin()
    await post('/request', { email: 'bob@example.com' })
    const pending = await call('/requests?status=pending', {}, cookie)
    expect(pending.body.requests.map((r: { email: string }) => r.email)).toEqual(['bob@example.com'])

    const approved = await post(`/requests/${pending.body.requests[0].id}/approve`, {}, cookie)
    expect(approved.body.grant).toMatchObject({ email: 'bob@example.com', scopes: ['reports'] })
    expect((await post('/exchange', { token: approved.body.token })).status).toBe(200)

    expect((await call('/requests?status=pending', {}, cookie)).body.requests).toEqual([])
  })

  it('404s approving or denying an unknown request', async () => {
    const cookie = await asAdmin()
    expect((await post('/requests/nope/approve', {}, cookie)).status).toBe(404)
    expect((await post('/requests/nope/deny', {}, cookie)).status).toBe(404)
  })
})

describe('logout', () => {
  it('clears the cookie', async () => {
    const cookie = await asAdmin()
    const res = await post('/logout', {}, cookie)
    expect(res.body).toEqual({ ok: true })
    expect(res.setCookie).toBe('oa_auth=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0')
  })
})

describe('per-creator sandboxing', () => {
  /** Two visitors, each admin of their own links — the demo's shape. */
  const sandboxed = () => {
    const g = createGate({
      store: d1GrantStore(db),
      audit: d1AuditSink(db),
      secret: SECRET,
      policy: firstMatch(adminPolicy(['boss@openathena.ai']), anyEmailPolicy(['*'])),
    })
    return {
      gate: g,
      handle: authRoutes(g, {
        audit: d1AuditQuery(db),
        creatorOf: a => (a.kind === 'sso' ? a.email : 'anon'),
        scopeToCreator: (a: Auth) => (a.kind === 'sso' ? a.email : undefined),
      }),
    }
  }

  const as = async (g: ReturnType<typeof createGate>, email: string) =>
    pair((await g.signIn(email, new Request('https://x.test/'), NOW))!.cookie)

  it('shows each visitor only their own grants', async () => {
    const { gate: g, handle: h } = sandboxed()
    const [alice, bob] = await Promise.all([as(g, 'alice@demo.test'), as(g, 'bob@demo.test')])
    const mint = (cookie: string, name: string) =>
      h(new Request(url('/grants'), { method: 'POST', headers: { Cookie: cookie }, body: JSON.stringify({ name, scopes: ['x'] }) }))

    await mint(alice, 'alice-link')
    await mint(bob, 'bob-link')

    const list = async (cookie: string) => {
      const res = await h(new Request(url('/grants'), { headers: { Cookie: cookie } }))
      return (await res!.json<{ grants: { name: string }[] }>()).grants.map(x => x.name)
    }
    expect(await list(alice)).toEqual(['alice-link'])
    expect(await list(bob)).toEqual(['bob-link'])
  })

  it("404s (not 403s) revoking someone else's grant, so ids stay unconfirmed", async () => {
    const { gate: g, handle: h } = sandboxed()
    const [alice, bob] = await Promise.all([as(g, 'alice@demo.test'), as(g, 'bob@demo.test')])
    const minted = await h(
      new Request(url('/grants'), { method: 'POST', headers: { Cookie: alice }, body: JSON.stringify({ name: 'a', scopes: ['x'] }) }),
    )
    const { grant } = await minted!.json<{ grant: { id: string } }>()

    const byBob = await h(new Request(url(`/grants/${grant.id}/revoke`), { method: 'POST', headers: { Cookie: bob } }))
    expect(byBob!.status).toBe(404)
    expect((await g.list()).map(x => x.revokedAt)).toEqual([null])

    const byAlice = await h(new Request(url(`/grants/${grant.id}/revoke`), { method: 'POST', headers: { Cookie: alice } }))
    expect(byAlice!.status).toBe(200)
  })

  it('rotate is admin+owner-gated and re-keys the caller’s own grant, returning the token once', async () => {
    const { gate: g, handle: h } = sandboxed()
    const [alice, bob] = await Promise.all([as(g, 'alice@demo.test'), as(g, 'bob@demo.test')])
    const minted = await h(
      new Request(url('/grants'), { method: 'POST', headers: { Cookie: alice }, body: JSON.stringify({ name: 'a', scopes: ['x'] }) }),
    )
    const { grant, token } = await minted!.json<{ grant: { id: string }; token: string }>()

    // Anonymous → 401; someone else's grant → 404 (id stays unconfirmed).
    expect((await h(new Request(url(`/grants/${grant.id}/rotate`), { method: 'POST' })))!.status).toBe(401)
    expect((await h(new Request(url(`/grants/${grant.id}/rotate`), { method: 'POST', headers: { Cookie: bob } })))!.status).toBe(404)

    // The owner re-keys: 200, a fresh token, same id.
    const res = await h(new Request(url(`/grants/${grant.id}/rotate`), { method: 'POST', headers: { Cookie: alice } }))
    expect(res!.status).toBe(200)
    const rekeyed = await res!.json<{ id: string; token: string }>()
    expect(rekeyed.id).toBe(grant.id)
    expect(rekeyed.token).toMatch(/^[A-Za-z0-9_-]{32}$/)
    expect(rekeyed.token).not.toBe(token)
  })
})

describe('access log routes', () => {
  it('501s when no audit query is wired', async () => {
    const bare = authRoutes(gate, {})
    const cookie = await asAdmin()
    const res = await bare(new Request(url('/log'), { headers: { Cookie: cookie } }))
    expect(res!.status).toBe(501)
  })

  it('returns a link’s trail and its activity summary', async () => {
    const cookie = await asAdmin()
    const minted = await post('/grants', { name: 'Bob', scopes: ['reports'] }, cookie)
    const id: string = minted.body.grant.id
    await post('/exchange', { token: minted.body.token })
    await handle(new Request(`https://x.test/api/auth/whoami?key=${minted.body.token}`))

    // Newest first, so the admin who minted it is the tail of the trail.
    const log = await call(`/log?grant=${id}`, {}, cookie)
    expect(log.body.events.map((e: { event: string; sessionSub: string }) => [e.event, e.sessionSub])).toEqual([
      ['redeem', `g:${id}`],
      ['mint', 'e:boss@openathena.ai'],
    ])

    // Routes don't take an injected clock (that seam is core-level), so the two
    // timestamps are wall-clock: assert they're the same recent second, then
    // compare the rest exactly.
    const activity = await call(`/grants/${id}/activity`, {}, cookie)
    const nowS = Math.floor(Date.now() / 1000)
    const { firstSeen, lastSeen, ...rest } = activity.body
    expect([firstSeen === lastSeen, nowS - firstSeen < 10]).toEqual([true, true])
    expect(rest).toEqual({
      grantId: id,
      distinctIps: 0, // no CF-Connecting-IP on these requests
      countries: [],
      views: 0,
      topPaths: [],
    })
  })
})
