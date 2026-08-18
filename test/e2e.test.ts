/**
 * The link lifecycle end to end: real routes, a real store, and the cookie
 * actually threaded from one request into the next.
 *
 * Every row here is a *security* property, and each one is invisible to unit
 * tests of the primitives — those check that `redeem` returns a cookie, not
 * that presenting that cookie to a gated route works and that presenting it
 * one millisecond after a revoke does not. The table is watchy's: these are
 * the eight things it verified by hand during adoption, which is precisely the
 * argument for pinning them in CI (see specs/auth-upstream-followups.md §3).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { d1AuditSink, d1GrantStore } from '../src/adapters/d1.js'
import { createGate } from '../src/core/gate.js'
import { adminPolicy } from '../src/core/policy.js'
import { authRoutes } from '../src/core/routes.js'
import { hasScope, type NewGrant } from '../src/core/types.js'
import { testDb } from './d1-shim.js'

const SECRET = 'test-secret-0123456789abcdef'
const ADMIN = 'boss@openathena.ai'

let db: D1Database
let gate: ReturnType<typeof createGate>
let app: (path: string, init?: RequestInit & { cookie?: string }) => Promise<AppResponse>

interface AppResponse {
  status: number
  body: Record<string, unknown> | null
  cookie: string | null
}

/**
 * The whole app: the package's auth surface, then one gated route and one
 * admin-only route of its own. This is the shape a consumer mounts, so the
 * fall-through and the `hasScope` check are under test too.
 */
function mountApp() {
  const routes = authRoutes(gate, { adminScope: 'admin' })
  return async (path: string, init: RequestInit & { cookie?: string } = {}): Promise<AppResponse> => {
    const { cookie, ...rest } = init
    const headers = new Headers(rest.headers)
    if (cookie) headers.set('Cookie', cookie)
    if (rest.body) headers.set('content-type', 'application/json')
    const req = new Request(`https://x.test${path}`, { ...rest, headers })

    const handled = await routes(req)
    const res = handled ?? (await gatedRoute(req))
    const text = await res.text()
    return {
      status: res.status,
      body: text ? JSON.parse(text) : null,
      cookie: res.headers.get('set-cookie')?.split(';')[0] ?? null,
    }
  }
}

/** The app's own data, behind the `reports` scope. */
async function gatedRoute(req: Request): Promise<Response> {
  const auth = await gate.authenticate(req)
  if (!auth) return new Response(JSON.stringify({ error: 'unauthenticated' }), { status: 401 })
  if (!hasScope(auth, 'reports')) return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 })
  return new Response(JSON.stringify({ revenue: 42 }), { status: 200 })
}

interface LogRow {
  event: string
  grant_id: string | null
  session_sub: string | null
  reason: string | null
  bucket: number | null
}

const logRows = async (): Promise<LogRow[]> =>
  (await db.prepare('SELECT event, grant_id, session_sub, reason, bucket FROM access_log ORDER BY id').all<LogRow>())
    .results ?? []

/** Mint a link directly (the admin half is covered by routes.test.ts) and open it. */
const link = (over: Partial<NewGrant> = {}) =>
  gate.mint({ name: 'Bob', scopes: ['reports'], createdBy: ADMIN, ...over })

beforeEach(() => {
  db = testDb()
  gate = createGate({
    store: d1GrantStore(db),
    audit: d1AuditSink(db),
    secret: SECRET,
    adminEmails: [ADMIN],
    policy: adminPolicy([ADMIN]),
  })
  app = mountApp()
})

describe('link lifecycle', () => {
  it('redeem mints a session cookie with the flags that make it a session cookie', async () => {
    const { token } = await link()
    const res = await app('/api/auth/exchange', { method: 'POST', body: JSON.stringify({ token }) })
    expect(res.status).toBe(200)

    // The attributes are the security property, not decoration: no JS access,
    // no plaintext hop, no cross-site send.
    const raw = (await routesRaw('/api/auth/exchange', { token }))!
    expect(raw.split('; ').slice(1)).toEqual(['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=2592000'])
  })

  it('a grant reads gated data but cannot administer', async () => {
    const { token } = await link()
    const { cookie } = await app('/api/auth/exchange', { method: 'POST', body: JSON.stringify({ token }) })

    const data = await app('/api/data', { cookie: cookie! })
    const admin = await app('/api/auth/grants', { cookie: cookie! })
    expect([data.status, data.body, admin.status]).toEqual([200, { revenue: 42 }, 403])
  })

  it('revoke is immediate: the same cookie fails on the very next request', async () => {
    const { grant, token } = await link()
    const { cookie } = await app('/api/auth/exchange', { method: 'POST', body: JSON.stringify({ token }) })
    expect((await app('/api/data', { cookie: cookie! })).status).toBe(200)

    await gate.revoke(grant.id)
    expect((await app('/api/data', { cookie: cookie! })).status).toBe(401)
    expect((await app('/api/auth/whoami', { cookie: cookie! })).status).toBe(401)
  })

  it('counts redemptions, not requests', async () => {
    const { grant, token } = await link()
    const { cookie } = await app('/api/auth/exchange', { method: 'POST', body: JSON.stringify({ token }) })
    for (let i = 0; i < 5; i++) await app('/api/data', { cookie: cookie! })
    // A second browser opening the same link is the thing that counts.
    await app('/api/auth/exchange', { method: 'POST', body: JSON.stringify({ token }) })

    const row = await db.prepare('SELECT redeems, first_used_at, last_used_at FROM grants WHERE id = ?').bind(grant.id).first<{
      redeems: number
      first_used_at: number
      last_used_at: number
    }>()
    expect(row!.redeems).toBe(2)
    // `touch` is throttled to once a minute, so six requests in one second
    // leave `last_used_at` where the redemption put it.
    expect(row!.last_used_at).toBe(row!.first_used_at)
  })

  it('refuses a redemption past `maxRedeems`, and says which failure it was', async () => {
    const { token } = await link({ maxRedeems: 2 })
    const results = []
    for (let i = 0; i < 3; i++) results.push(await app('/api/auth/exchange', { method: 'POST', body: JSON.stringify({ token }) }))
    expect(results.map(r => r.status)).toEqual([200, 200, 401])
    expect(results[2]!.body).toEqual({ error: 'invalid link', reason: 'exhausted' })
  })

  it('expiry refuses new redemptions and kills sessions already minted', async () => {
    const nowS = Math.floor(Date.now() / 1000)
    const { grant, token } = await link({ expiresAt: nowS + 3600 })
    const { cookie } = await app('/api/auth/exchange', { method: 'POST', body: JSON.stringify({ token }) })
    expect((await app('/api/data', { cookie: cookie! })).status).toBe(200)

    // Expire it out from under the live session. The cookie is still perfectly
    // valid — it is the per-request re-join that ends the session.
    await db.prepare('UPDATE grants SET expires_at = ? WHERE id = ?').bind(nowS - 1, grant.id).run()
    const after = await app('/api/auth/exchange', { method: 'POST', body: JSON.stringify({ token }) })
    expect([after.status, after.body]).toEqual([401, { error: 'invalid link', reason: 'expired' }])
    expect((await app('/api/data', { cookie: cookie! })).status).toBe(401)
  })

  it('leaves an audit trail that names both the link and the session', async () => {
    const { grant, token } = await link()
    const { cookie } = await app('/api/auth/exchange', { method: 'POST', body: JSON.stringify({ token }) })
    await gate.revoke(grant.id)
    await app('/api/data', { cookie: cookie! })

    expect((await logRows()).map(r => [r.event, r.grant_id, r.session_sub, r.reason])).toEqual([
      ['mint', grant.id, `e:${ADMIN}`, null],
      ['redeem', grant.id, `g:${grant.id}`, null],
      ['revoke', grant.id, null, null],
      ['deny', grant.id, `g:${grant.id}`, 'revoked'],
    ])
  })

  it('never dedupes a denial from a presented token — repeats there are probing', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await app('/api/auth/exchange', { method: 'POST', body: JSON.stringify({ token: 'not-a-real-token' }) })
      expect([res.status, res.body]).toEqual([401, { error: 'invalid link', reason: 'bad-token' }])
    }
    // Three attempts, three rows: the dedupe only ever applies to a *session*
    // that keeps re-presenting a dead cookie, never to someone trying tokens.
    //
    // `bucket` is the assertion that bites. Row *count* alone can't tell the
    // guard apart from luck: these rows have a NULL `session_sub`, and SQLite
    // treats NULLs as distinct in a unique index, so they would never collide
    // even if they were bucketed. A NULL bucket is the difference between
    // "deliberately not deduped" and "accidentally didn't collide".
    expect((await logRows()).map(r => [r.event, r.reason, r.bucket])).toEqual([
      ['deny', 'bad-token', null],
      ['deny', 'bad-token', null],
      ['deny', 'bad-token', null],
    ])
  })

  it('never lets an identity response be stored by anything in between', async () => {
    const { token } = await link()
    const { cookie } = await app('/api/auth/exchange', { method: 'POST', body: JSON.stringify({ token }) })
    const routes = authRoutes(gate, {})
    const heads = await Promise.all(
      ['/api/auth/whoami', '/api/auth/grants'].map(async p =>
        (await routes(new Request(`https://x.test${p}`, { headers: { Cookie: cookie! } })))!.headers.get('cache-control'),
      ),
    )
    expect(heads).toEqual(['no-store', 'no-store'])
  })
})

/** The raw `set-cookie`, attributes included — `app()` keeps only the pair. */
async function routesRaw(path: string, body: unknown): Promise<string | null> {
  const routes = authRoutes(gate, {})
  const res = await routes(
    new Request(`https://x.test${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
  return res!.headers.get('set-cookie')
}
