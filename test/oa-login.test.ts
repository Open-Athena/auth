/**
 * `@open-athena/auth/oa-login` (specs/oa-login-rp.md): the broker's config, start and callback routes, the silent
 * attempt, and the skip cookie. The broker is never reached: the start is a redirect, and the callbacks here fail
 * before the token exchange, which is `oidcCallback`'s (`oidc.test.ts`).
 */
import { describe, expect, it } from 'vitest'
import { createGate } from '../src/core/gate.js'
import { domainPolicy } from '../src/core/policy.js'
import {
  ATTEMPT_TTL_S,
  clearedOnSignIn,
  markedSignedOut,
  OA_HINT_COOKIE,
  OA_WHO_COOKIE,
  oaCallback,
  oaLoginOptions,
  oaStart,
  rememberAccount,
  rememberedAccount,
  resumed,
  type SilentApp,
  silentAttempt,
} from '../src/adapters/oa-login.js'
import { memoryStore } from './memory-store.js'

const SECRET = 'test-secret-0123456789abcdef'
const ORIGIN = 'https://app.example.test'
const ENV = { OA_LOGIN_ISSUER: 'https://login.example.test/', OA_LOGIN_CLIENT_ID: 'app-test', OA_LOGIN_CLIENT_SECRET: 'shh' }
const gate = createGate({ store: memoryStore(), secret: SECRET, policy: domainPolicy(['example.test'], ['*']) })

const setCookies = (res: Response): string[] => (res.headers as unknown as { getSetCookie(): string[] }).getSetCookie()
const outcome = (r: Response) => [r.status, r.headers.get('location'), setCookies(r)]
const NAV = { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }
const ATTEMPT = `oa_sso_skip=attempt; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${ATTEMPT_TTL_S}`
const SIGNED_OUT = 'oa_sso_skip=signout; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=34560000'
const CLEARED = 'oa_sso_skip=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0'

const app = (over: Partial<SilentApp> = {}): SilentApp => ({
  notWalled: /^\/(api|auth)(\/|$)|^\/signin\/?$/,
  anonymous: () => false,
  configured: () => true,
  presents: async () => false,
  ...over,
})
const visit = (path: string, headers: Record<string, string> = NAV, method = 'GET') =>
  new Request(`${ORIGIN}${path}`, { method, headers })

describe('oaLoginOptions', () => {
  it('is null unless the gate, issuer, client id and secret are all there', () => {
    const req = new Request(`${ORIGIN}/auth/oa`)
    const got = [null, 'OA_LOGIN_ISSUER', 'OA_LOGIN_CLIENT_ID', 'OA_LOGIN_CLIENT_SECRET'].map(drop =>
      oaLoginOptions(gate, drop ? { ...ENV, [drop]: undefined } : ENV, req) === null)
    expect([...got, oaLoginOptions(null, ENV, req) === null]).toEqual([false, true, true, true, true])
  })

  it("points at the broker's endpoints, with this origin's callback and the default paths", () => {
    const cfg = oaLoginOptions(gate, ENV, new Request(`${ORIGIN}/x`))!
    expect({ ...cfg, gate: undefined }).toEqual({
      gate: undefined,
      clientId: 'app-test',
      clientSecret: 'shh',
      redirectUri: `${ORIGIN}/auth/oa/callback`,
      provider: {
        authUrl: 'https://login.example.test/oidc/authorize',
        tokenUrl: 'https://login.example.test/oidc/token',
        jwksUrl: 'https://login.example.test/oidc/jwks',
        issuer: 'https://login.example.test',
        scope: 'openid email profile',
      },
      nonceCookieName: 'oa_login_nonce',
      accountHintCookie: false,
      signInPath: '/signin',
      home: '/',
    })
  })

  it('takes its paths from the host', () => {
    const cfg = oaLoginOptions(gate, ENV, new Request(`${ORIGIN}/x`), { callbackPath: '/sso/cb', signInPath: '/login', home: '/hub/' })!
    expect([cfg.redirectUri, cfg.signInPath, cfg.home]).toEqual([`${ORIGIN}/sso/cb`, '/login', '/hub/'])
  })

  it('a preview host uses only the preview pair, its callback on the request\'s own origin', () => {
    const req = new Request('https://pr-3.app.pages.dev/x')
    const preview = { ...ENV, OA_LOGIN_PREVIEW_CLIENT_ID: 'app-test-preview', OA_LOGIN_PREVIEW_CLIENT_SECRET: 'p' }
    const cfg = oaLoginOptions(gate, preview, req, { preview: true })!
    const redirect = cfg.redirectUri as (r: Request) => string
    expect([cfg.clientId, redirect(req), oaLoginOptions(gate, ENV, req, { preview: true })]).toEqual([
      'app-test-preview', 'https://pr-3.app.pages.dev/auth/oa/callback', null,
    ])
  })
})

describe('oaStart', () => {
  it('unconfigured: 404', async () => {
    expect((await oaStart(null, new Request(`${ORIGIN}/auth/oa`))).status).toBe(404)
  })

  it("redirects to the broker's authorize endpoint with PKCE S256 and a nonce, and no `hd`", async () => {
    const req = new Request(`${ORIGIN}/auth/oa?next=%2Fscans`)
    const r = await oaStart(oaLoginOptions(gate, ENV, req), req)
    const loc = new URL(r.headers.get('location')!)
    const q = Object.fromEntries(loc.searchParams)
    expect([r.status, `${loc.origin}${loc.pathname}`, q.client_id, q.redirect_uri, q.response_type, q.scope, q.code_challenge_method, !!q.code_challenge, !!q.nonce, !!q.state, 'hd' in q])
      .toEqual([302, 'https://login.example.test/oidc/authorize', 'app-test', `${ORIGIN}/auth/oa/callback`, 'code', 'openid email profile', 'S256', true, true, true, false])
  })

  it('an explicit start clears the skip cookie; a silent one keeps it', async () => {
    const skip = { cookie: 'oa_sso_skip=signout' }
    const explicit = new Request(`${ORIGIN}/auth/oa`, { headers: skip })
    const silent = new Request(`${ORIGIN}/auth/oa?prompt=none`, { headers: skip })
    const cleared = (r: Response) => setCookies(r).filter(c => c.startsWith('oa_sso_skip='))
    expect([
      cleared(await oaStart(oaLoginOptions(gate, ENV, explicit), explicit)),
      cleared(await oaStart(oaLoginOptions(gate, ENV, silent), silent)),
    ]).toEqual([[CLEARED], []])
  })
})

describe('oaCallback', () => {
  const call = async (query: string, cookie?: string, host = {}) => {
    const req = new Request(`${ORIGIN}/auth/oa/callback${query}`, cookie ? { headers: { cookie } } : {})
    return outcome(await oaCallback(oaLoginOptions(gate, ENV, req, host), req))
  }

  it('unconfigured: 404', async () => {
    expect((await oaCallback(null, new Request(`${ORIGIN}/auth/oa/callback`))).status).toBe(404)
  })

  it("an explicit failure lands on the sign-in page with `error=oa:<reason>`; a no-interaction answer quietly with `sso=`", async () => {
    expect([
      await call('?error=access_denied'),
      await call(''),
      await call('?code=x&state=forged'),
      await call('?error=login_required&state=y'),
    ]).toEqual([
      [302, '/signin?error=oa%3Aaccess_denied', []],
      [302, '/signin?error=oa%3Amissing%20code%20or%20state', []],
      [302, '/signin?error=oa%3Abad%20state', []],
      [302, '/signin?sso=login_required', []],
    ])
  })

  it('a silent attempt that fails in the adapter lands on `home` with `?sso=error`', async () => {
    expect(await call('?code=x&state=forged', 'oa_sso_skip=attempt', { home: '/hub/' })).toEqual([302, '/hub/?sso=error', []])
  })

  it('the sign-in path is an option', async () => {
    expect(await call('?error=access_denied', undefined, { signInPath: '/login' })).toEqual([302, '/login?error=oa%3Aaccess_denied', []])
  })
})

describe('silentAttempt', () => {
  it('a person\'s top-level visit goes to the start with `prompt=none`, keeping its path and query, marked attempted', async () => {
    expect([
      outcome((await silentAttempt(visit('/'), app()))!),
      outcome((await silentAttempt(visit('/p/sessions/x?a=1'), app()))!),
      outcome((await silentAttempt(visit('/p/'), app({ startPath: '/sso/start' })))!),
    ]).toEqual([
      [302, '/auth/oa?prompt=none&next=%2F', [ATTEMPT]],
      [302, '/auth/oa?prompt=none&next=%2Fp%2Fsessions%2Fx%3Fa%3D1', [ATTEMPT]],
      [302, '/sso/start?prompt=none&next=%2Fp%2F', [ATTEMPT]],
    ])
  })

  it('never for anything else', async () => {
    const cases: [Request, SilentApp][] = [
      [visit('/', {}), app()],
      [visit('/', { 'sec-fetch-mode': 'navigate' }), app()],
      [visit('/', { ...NAV, 'sec-fetch-dest': 'iframe' }), app()],
      [visit('/', { ...NAV, 'sec-purpose': 'prefetch' }), app()],
      [visit('/', NAV, 'POST'), app()],
      [visit('/api/x'), app()],
      [visit('/auth/oa/callback'), app()],
      [visit('/signin'), app()],
      [visit('//evil.example.test/x'), app()],
      [visit('/?key=abc'), app()],
      [visit('/?sso=login_required'), app()],
      [visit('/?denied=a%40b.test'), app()],
      [visit('/', { ...NAV, cookie: 'oa_sso_skip=attempt' }), app()],
      [visit('/', { ...NAV, cookie: 'oa_sso_skip=signout' }), app()],
      [visit('/', { ...NAV, authorization: 'Bearer x' }), app()],
      [visit('/'), app({ anonymous: () => true })],
      [visit('/'), app({ configured: () => false })],
      [visit('/'), app({ presents: async () => true })],
    ]
    const got = []
    for (const [req, a] of cases) got.push(await silentAttempt(req, a))
    expect(got).toEqual(Array(cases.length).fill(null))
  })
})

describe('the skip cookie', () => {
  const res = () => new Response(null, { status: 204 })

  it('a logout marks the browser signed out, when configured', () => {
    const req = new Request(`${ORIGIN}/api/auth/logout`, { method: 'POST' })
    expect([setCookies(markedSignedOut(req, true, res())), setCookies(markedSignedOut(req, false, res()))]).toEqual([[SIGNED_OUT], []])
  })

  it('`resumed` clears it only when it\'s there', () => {
    const marked = new Request(ORIGIN, { headers: { cookie: 'oa_sso_skip=signout' } })
    expect([setCookies(resumed(marked, res())), setCookies(resumed(new Request(ORIGIN), res()))]).toEqual([[CLEARED], []])
  })

  it('any response minting the session clears it; a cleared session or other cookies don\'t', () => {
    const marked = new Request(ORIGIN, { headers: { cookie: 'oa_sso_skip=signout' } })
    const withCookie = (c: string) => { const r = res(); r.headers.append('set-cookie', c); return r }
    expect([
      setCookies(clearedOnSignIn(marked, 'oa_auth', () => true, withCookie('oa_auth=v; Path=/'))),
      setCookies(clearedOnSignIn(marked, 'oa_auth', () => true, withCookie('oa_auth=; Path=/; Max-Age=0'))),
      setCookies(clearedOnSignIn(marked, 'oa_auth', () => true, withCookie('other=v; Path=/'))),
      setCookies(clearedOnSignIn(marked, 'oa_auth', () => false, withCookie('oa_auth=v; Path=/'))),
    ]).toEqual([
      ['oa_auth=v; Path=/', CLEARED],
      ['oa_auth=; Path=/; Max-Age=0'],
      ['other=v; Path=/'],
      ['oa_auth=v; Path=/'],
    ])
  })
})

describe('the remembered account', () => {
  it('signs the address a completed sign-in hinted, and reads it back only from that signed cookie', async () => {
    const req = new Request(`${ORIGIN}/auth/oa/callback`)
    const signedIn = new Response(null, { status: 302, headers: { location: '/' } })
    signedIn.headers.append('set-cookie', `${OA_HINT_COOKIE}=Ada%40example.test; Path=/; HttpOnly`)
    const out = await rememberAccount(signedIn, req, { hintCookie: OA_HINT_COOKIE, whoCookie: OA_WHO_COOKIE, secret: SECRET })
    const who = setCookies(out).find(c => c.startsWith(`${OA_WHO_COOKIE}=`))!.split(';')[0]!
    const read = (cookie: string) => rememberedAccount(new Request(ORIGIN, { headers: { cookie } }), OA_WHO_COOKIE, SECRET)
    const none = await rememberAccount(new Response(null), req, { hintCookie: OA_HINT_COOKIE, whoCookie: OA_WHO_COOKIE, secret: SECRET })
    expect([await read(who), await read(`${OA_WHO_COOKIE}=forged`), await read(`${OA_HINT_COOKIE}=ada%40example.test`), setCookies(none)])
      .toEqual(['ada@example.test', null, null, []])
  })
})
