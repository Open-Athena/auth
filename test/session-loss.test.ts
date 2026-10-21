import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { d1GrantStore } from '../src/adapters/d1.js'
import { b64uEncode } from '../src/core/base64.js'
import { createGate } from '../src/core/gate.js'
import { authRoutes } from '../src/core/routes.js'
import { signSession } from '../src/core/session.js'
import { memoryStore } from './memory-store.js'
import { testDb } from './d1-shim.js'

const SECRET = 'test-secret-0123456789abcdef'
const NOW = Date.parse('2026-08-16T00:00:00Z')
const pair = (cookie: string) => cookie.split(';')[0]!
const request = (cookie?: string, path = '/data', headers: Record<string, string> = {}) =>
  new Request(`https://x.test${path}`, { headers: { ...(cookie === undefined ? {} : { Cookie: cookie }), ...headers } })

async function denial(res: Response, reason: string | null, cookie: string | null = null) {
  expect({
    status: res.status,
    body: await res.text(),
    type: res.headers.get('content-type'),
    cache: res.headers.get('cache-control'),
    cookie: res.headers.get('set-cookie'),
    clear: res.headers.get('clear-site-data'),
  }).toEqual({
    status: 401,
    body: JSON.stringify({ error: 'unauthenticated', reason }) + '\n',
    type: 'application/json; charset=utf-8',
    cache: 'no-store',
    cookie,
    clear: cookie === null ? null : '"cache"',
  })
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})
afterEach(() => vi.useRealTimers())

describe.each(['D1', 'memory'] as const)('%s session loss', backend => {
  const setup = () => {
    const store = backend === 'D1' ? d1GrantStore(testDb()) : memoryStore()
    let allowed = true
    const gate = createGate({ store, secret: SECRET, policy: () => allowed ? ['read'] : null })
    const routes = authRoutes(gate, {})
    const protectedRoute = async (req: Request) => {
      const result = await gate.authenticateResult(req, Date.now(), { logView: false })
      return result.auth ? Response.json({ ok: true }) : gate.unauthenticated(req, result)
    }
    const check = async (cookie: string, reason: string) => {
      const expired = 'oa_auth=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0'
      expect(await gate.authenticateResult(request(cookie))).toEqual({ auth: null, reason, credential: 'cookie' })
      expect(await gate.authenticate(request(cookie))).toBeNull()
      await denial(await protectedRoute(request(cookie)), reason, expired)
      for (const path of ['/whoami', '/grants', '/profile']) {
        const res = await routes(request(cookie, `/api/auth${path}`))
        expect(res).not.toBeNull()
        await denial(res!, reason, expired)
      }
    }
    const mint = async (options = {}) => {
      const minted = await gate.mint({ scopes: ['read'], createdBy: 'boss@example.com', ...options }, NOW)
      const redeemed = await gate.redeem(minted.token, request(), NOW)
      if (!redeemed.ok) throw new Error('expected redemption')
      return { ...minted, cookie: pair(redeemed.cookie) }
    }
    return { store, gate, routes, protectedRoute, check, mint, delist: () => { allowed = false } }
  }

  it('revokes existing sessions and reuses the result without a second grant read', async () => {
    const { gate, store, mint, check, protectedRoute } = setup()
    const { grant, cookie } = await mint()
    expect(await (await protectedRoute(request(cookie))).json()).toEqual({ ok: true })
    await gate.revoke(grant.id)
    const read = vi.spyOn(store, 'byId')
    await denial(await protectedRoute(request(cookie)), 'revoked', gate.expireCookie(request()))
    expect(read).toHaveBeenCalledTimes(1)
    await check(cookie, 'revoked')
  })

  it.each([true, false])('expiryEndsSessions=%s respects existing disabled-link sessions', async expiryEndsSessions => {
    const { gate, mint, check } = setup()
    const { grant, cookie } = await mint({ expiresAt: NOW / 1000 + 1, expiryEndsSessions })
    await gate.disable(grant.id)
    vi.setSystemTime(NOW + 1000)
    if (expiryEndsSessions) await check(cookie, 'expired')
    else {
      const auth = await gate.authenticate(request(cookie))
      expect(auth?.kind).toBe('grant')
      expect(await gate.authenticateResult(request(cookie))).toEqual({ auth, reason: null, credential: 'cookie' })
    }
  })

  it.each([true, false])('rotation endSessions=%s only ends sessions when requested', async endSessions => {
    const { gate, mint, check } = setup()
    const { grant, cookie } = await mint()
    vi.setSystemTime(NOW + 1000)
    const rotated = await gate.rotate(grant.id, { endSessions })
    if (!rotated) throw new Error('expected rotation')
    if (endSessions) await check(cookie, 'rotated')
    else expect((await gate.authenticate(request(cookie)))?.kind).toBe('grant')
    const fresh = await gate.redeem(rotated.token, request())
    if (!fresh.ok) throw new Error('expected fresh redemption')
    expect((await gate.authenticate(request(pair(fresh.cookie))))?.kind).toBe('grant')
  })

  it('delists an SSO session on its next request', async () => {
    const { gate, delist, check } = setup()
    const signed = await gate.signIn('reader@example.com', request())
    if (!signed) throw new Error('expected sign in')
    delist()
    await check(pair(signed.cookie), 'delisted')
  })

  it('distinguishes signed expiry from malformed or forged expired claims', async () => {
    const { check } = setup()
    await check(`oa_auth=${await signSession('e:reader@example.com', SECRET, NOW - 2000, 1)}`, 'expired')
    await check('oa_auth=broken', 'invalid')
    await check('oa_auth=', 'invalid')
    const signed = await signSession('e:reader@example.com', SECRET, NOW)
    const body = b64uEncode(new TextEncoder().encode(JSON.stringify({ v: 1, sub: 'e:reader@example.com', iat: 0, exp: 1 })))
    await check(`oa_auth=${body}.${signed.split('.')[1]}`, 'invalid')
    await check(`oa_auth=${await signSession('e:reader@example.com', 'wrong-secret', NOW - 2000, 1)}`, 'invalid')
  })

  it('does not clear anything when the session cookie is absent', async () => {
    const { gate, protectedRoute } = setup()
    for (const cookie of [undefined, 'unrelated=keep']) {
      const req = request(cookie)
      expect(await gate.authenticateResult(req)).toEqual({ auth: null, reason: null, credential: 'none' })
      await denial(await protectedRoute(req), null)
      await denial(await gate.unauthenticated(req), null)
    }
  })

  it.each([
    ['/data', { Authorization: 'Bearer bogus' }],
    ['/data', { Authorization: 'Bearer' }],
    ['/data', { Authorization: 'Bearer ' }],
    ['/data?key=bogus', {}],
    ['/data?key=', {}],
    ['/data?key', {}],
  ] as const)('explicit credential %s %j never clears a live cookie', async (path, headers) => {
    const { gate, mint, protectedRoute, routes } = setup()
    const { cookie } = await mint()
    for (const suppliedCookie of [undefined, cookie]) {
      const req = request(suppliedCookie, path, headers)
      expect(await gate.authenticateResult(req)).toEqual({ auth: null, reason: 'invalid', credential: 'token' })
      await denial(await protectedRoute(req), 'invalid')
      await denial(await gate.unauthenticated(req), 'invalid')
      await denial((await routes(request(suppliedCookie, path.replace('/data', '/api/auth/whoami'), headers)))!, 'invalid')
    }
    expect(await (await protectedRoute(request(cookie))).json()).toEqual({ ok: true })
  })
})

it.each(['http', 'https'])('clears only the configured cookie with %s-appropriate Secure', async protocol => {
  const gate = createGate({ store: memoryStore(), secret: SECRET, cookieName: 'custom_session' })
  const req = new Request(`${protocol}://x.test/data`, { headers: { Cookie: 'oa_auth=keep; custom_session=bad; other=keep' } })
  await denial(await gate.unauthenticated(req), 'invalid', `custom_session=; HttpOnly;${protocol === 'https' ? ' Secure;' : ''} SameSite=Lax; Path=/; Max-Age=0`)
  await denial(await gate.unauthenticated(new Request(`${protocol}://x.test/data`, { headers: { Cookie: 'oa_auth=bad; other=keep' } })), null)
})
