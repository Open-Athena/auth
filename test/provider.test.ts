/**
 * The OIDC provider end to end, in process: a broker (a gate plus
 * `oidcProviderRoutes`) and two apps signing in through it with the real
 * relying party (`oidcStart` / `oidcCallback`). One `Browser` carries a cookie
 * jar per host and follows redirects across them, so "app B with no page in
 * between" is asserted as the exact hops a browser makes.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { oidcCallback, oidcStart } from '../src/adapters/oidc.js'
import { b64uDecodeString, b64uEncode } from '../src/core/base64.js'
import { createGate, type Gate } from '../src/core/gate.js'
import { brokerProvider, generateSigningKey, hashClientSecret, keySet, memoryProviderStore, oidcProviderRoutes, type ProviderClient, type SigningJwk } from '../src/provider/index.js'
import { d1GrantStore } from '../src/adapters/d1.js'
import { d1ProviderStore } from '../src/adapters/d1-provider.js'
import { d1RetainedStore } from '../src/adapters/d1-retained.js'
import { SELECTION_CONTEXT_HEADER } from '../src/core/selection-context.js'
import { testDbRaw } from './d1-shim.js'
import { memoryAudit, memoryStore } from './memory-store.js'

const ISSUER = 'https://login.test'
const T0 = Date.UTC(2026, 9, 25, 12, 0, 0)
const enc = new TextEncoder()

let KEY: SigningJwk
let OTHER_KEY: SigningJwk
beforeAll(async () => {
  KEY = await generateSigningKey('k1')
  OTHER_KEY = await generateSigningKey('k1')
})
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
})
afterEach(() => {
  vi.useRealTimers()
})

const at = (s: number) => vi.setSystemTime(T0 + s * 1000)
const setCookies = (res: Response): string[] => (res.headers as unknown as { getSetCookie(): string[] }).getSetCookie()
const claimsOf = (jwt: string) => JSON.parse(b64uDecodeString(jwt.split('.')[1]!)) as Record<string, unknown>

/** A browser: a cookie jar per host, following redirects across hosts. */
class Browser {
  jars = new Map<string, Map<string, string>>()
  constructor(private net: (req: Request) => Promise<Response>) {}
  jar(host: string) {
    if (!this.jars.has(host)) this.jars.set(host, new Map())
    return this.jars.get(host)!
  }
  take(host: string, cookies: string[]) {
    for (const c of cookies) {
      const [pair, ...attrs] = c.split(';')
      const i = pair!.indexOf('=')
      const name = pair!.slice(0, i).trim()
      const value = pair!.slice(i + 1)
      if (attrs.some(a => a.trim() === 'Max-Age=0') || value === '') this.jar(host).delete(name)
      else this.jar(host).set(name, value)
    }
  }
  async request(url: string, init: RequestInit = {}): Promise<Response> {
    const host = new URL(url).host
    const cookie = [...this.jar(host)].map(([k, v]) => `${k}=${v}`).join('; ')
    const headers = new Headers(init.headers)
    if (cookie) headers.set('cookie', cookie)
    const res = await this.net(new Request(url, { ...init, headers, redirect: 'manual' }))
    this.take(host, setCookies(res))
    return res
  }
  /** Follow redirects; returns every URL visited, the first included. */
  async follow(url: string): Promise<{ hops: string[]; res: Response }> {
    const hops = [url]
    let res = await this.request(url)
    while (res.status === 302) {
      const next = new URL(res.headers.get('location')!, hops.at(-1)).toString()
      hops.push(next)
      if (hops.length > 12) throw new Error(`redirect loop: ${hops.join(' → ')}`)
      res = await this.request(next)
    }
    return { hops, res }
  }
}

interface WorldOptions {
  policy?: (i: { email: string; client: ProviderClient }) => boolean
  allowB?: (email: string) => boolean
  /** A broker in retained mode: several accounts per browser. */
  retained?: boolean
  /** app-a may skip PKCE (`requirePkce: false`). */
  pkceOptionalA?: boolean
}

async function world(o: WorldOptions = {}) {
  const db = o.retained ? testDbRaw().db : null
  const broker = createGate({
    store: db ? d1GrantStore(db) : memoryStore(),
    audit: memoryAudit(),
    secret: 'broker-secret-0123456789abcdef',
    policy: async (e: string) => (e.endsWith('@openathena.ai') ? ['member'] : null),
    ...(db
      ? {
          retained: {
            store: d1RetainedStore(db, {
              sessions: 4, pending: 2, gateBrowserSets: 50, gatePending: 50,
              browserTtlS: 30 * 86400, pendingTtlS: 600, retryTtlS: 86400, defaultSessionTtlS: 3600,
            }),
          },
        }
      : {}),
  })
  const store = memoryProviderStore()
  const client = async (id: string, host: string, allow?: (e: string) => boolean): Promise<ProviderClient> => ({
    id,
    secretHash: await hashClientSecret(`${id}-secret`),
    redirectUris: [`https://${host}/auth/cb`],
    postLogoutRedirectUris: [`https://${host}/bye`],
    ...(allow ? { allow } : {}),
  })
  const provider = oidcProviderRoutes({
    gate: broker,
    issuer: ISSUER,
    clients: [
      { ...(await client('app-a', 'a.test')), ...(o.pkceOptionalA ? { requirePkce: false } : {}) },
      await client('app-b', 'b.test', o.allowB),
    ],
    keys: [KEY],
    store,
    subjectSecret: 'subject-secret',
    loginUrl: '/signin',
    claims: ({ scopes }) => (scopes.includes('groups') ? { groups: ['research'], email: 'forged@evil.test' } : {}),
    scopes: ['groups'],
    ...(o.policy ? { policy: o.policy } : {}),
  })
  const apps = new Map<string, { gate: Gate; start: ReturnType<typeof oidcStart>; callback: ReturnType<typeof oidcCallback> }>()
  // Server-to-server calls (token, JWKS) carry no browser cookies.
  const serverFetch = (async (input: RequestInfo | URL, init?: RequestInit) => net(new Request(input, init))) as typeof fetch
  for (const [host, id] of [['a.test', 'app-a'], ['b.test', 'app-b']] as const) {
    const gate = createGate({ store: memoryStore(), audit: memoryAudit(), secret: `${id}-gate-secret-0123456789`, policy: async () => ['view'] })
    const rp = {
      gate,
      clientId: id,
      clientSecret: `${id}-secret`,
      redirectUri: `https://${host}/auth/cb`,
      provider: brokerProvider(ISSUER),
      accountHintCookie: false as const,
      fetch: serverFetch,
    }
    apps.set(host, { gate, start: oidcStart(rp), callback: oidcCallback(rp) })
  }
  async function net(req: Request): Promise<Response> {
    const url = new URL(req.url)
    if (url.host === 'login.test') {
      const r = await provider(req)
      if (r) return r
      if (url.pathname === '/signin') return new Response('sign-in page')
      return new Response('broker page')
    }
    const app = apps.get(url.host)
    if (!app) return new Response('no such host', { status: 502 })
    if (url.pathname === '/auth/start') return app.start({ request: req })
    if (url.pathname === '/auth/cb') return app.callback({ request: req })
    return new Response(`${url.host} page`)
  }
  const browser = () => new Browser(net)
  /** Sign in at the broker (what its sign-in page does after Google or a code). */
  const signInAtBroker = async (b: Browser, email: string) => {
    const cookie = [...b.jar('login.test')].map(([k, v]) => `${k}=${v}`).join('; ')
    const r = await broker.signIn(email, new Request(`${ISSUER}/signin`, { headers: cookie ? { cookie } : {} }))
    if (!r) throw new Error(`broker refused ${email}`)
    b.take('login.test', r.cookies)
  }
  const whoAt = async (b: Browser, host: string) => {
    const cookie = [...b.jar(host)].map(([k, v]) => `${k}=${v}`).join('; ')
    const auth = await apps.get(host)!.gate.authenticate(new Request(`https://${host}/x`, { headers: { cookie } }))
    return auth?.kind === 'sso' ? auth.email : auth ? 'grant' : null
  }
  return { broker, provider, store, net, browser, signInAtBroker, whoAt }
}

/** A PKCE pair, for driving `/authorize` and `/token` by hand. */
async function pkce(verifier = 'v'.repeat(43)) {
  return { verifier, challenge: b64uEncode(await crypto.subtle.digest('SHA-256', enc.encode(verifier))) }
}

function authorizeUrl(params: Record<string, string>): string {
  const u = new URL(`${ISSUER}/oidc/authorize`)
  for (const [k, v] of Object.entries({ client_id: 'app-a', redirect_uri: 'https://a.test/auth/cb', response_type: 'code', scope: 'openid email', state: 's1', ...params })) {
    if (v !== '') u.searchParams.set(k, v)
  }
  return u.toString()
}

const tokenRequest = (form: Record<string, string>, headers: Record<string, string> = {}) =>
  new Request(`${ISSUER}/oidc/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(form).toString(),
  })

/** Query params of a redirect, as a plain object. */
const queryOf = (res: Response) => {
  const u = new URL(res.headers.get('location')!)
  return { to: `${u.origin}${u.pathname}`, params: Object.fromEntries(u.searchParams) }
}

describe('sign-in through the broker', () => {
  it('signed in at the broker: app A, then app B, with no page in between', async () => {
    const w = await world()
    const b = w.browser()
    await w.signInAtBroker(b, 'ada@openathena.ai')

    for (const host of ['a.test', 'b.test']) {
      const { hops, res } = await b.follow(`https://${host}/auth/start?next=/home`)
      expect(hops.map(h => `${new URL(h).host}${new URL(h).pathname}`)).toEqual([
        `${host}/auth/start`,
        'login.test/oidc/authorize',
        `${host}/auth/cb`,
        `${host}/home`,
      ])
      expect(await res.text()).toBe(`${host} page`)
      expect(await w.whoAt(b, host)).toBe('ada@openathena.ai')
    }
  })

  it('not signed in at the broker: its sign-in page, then straight back to the app', async () => {
    const w = await world()
    const b = w.browser()
    const { hops } = await b.follow('https://a.test/auth/start?next=/home')
    const login = new URL(hops.at(-1)!)
    expect(`${login.origin}${login.pathname}`).toBe('https://login.test/signin')
    const next = login.searchParams.get('next')!
    expect([...login.searchParams.keys()]).toEqual(['next'])
    expect(new URL(next, ISSUER).pathname).toBe('/oidc/authorize')

    await w.signInAtBroker(b, 'ada@openathena.ai')
    const back = await b.follow(new URL(next, ISSUER).toString())
    expect(back.hops.map(h => new URL(h).pathname)).toEqual(['/oidc/authorize', '/auth/cb', '/home'])
    expect(await w.whoAt(b, 'a.test')).toBe('ada@openathena.ai')
  })

  it('a silent attempt with no broker session comes back with login_required, not a page or a loop', async () => {
    const w = await world()
    const b = w.browser()
    const { hops } = await b.follow('https://a.test/auth/start?next=/home&prompt=none')
    expect(hops.map(h => { const u = new URL(h); return `${u.host}${u.pathname}${u.pathname === '/home' ? u.search : ''}` })).toEqual([
      'a.test/auth/start',
      'login.test/oidc/authorize',
      'a.test/auth/cb',
      'a.test/home?sso=login_required',
    ])
    expect(await w.whoAt(b, 'a.test')).toBe(null)
  })

  it('a share-link session at the broker is a guest: it never signs anyone in to an app', async () => {
    const w = await world()
    const b = w.browser()
    const { token } = await w.broker.mint({ name: 'Guest', scopes: ['member'], createdBy: 'boss@openathena.ai' })
    const redeemed = await w.broker.redeem(token, new Request(`${ISSUER}/x`, { headers: { 'user-agent': 'Mozilla/5.0 Chrome/140' } }))
    if (!redeemed.ok) throw new Error('redeem failed')
    b.take('login.test', redeemed.cookies)
    const { hops } = await b.follow('https://a.test/auth/start?next=/home&prompt=none')
    expect(new URL(hops.at(-1)!).search).toBe('?sso=login_required')
  })

  it('the provider policy and a client rule refuse with access_denied', async () => {
    const w = await world({ policy: ({ email }) => email !== 'bea@openathena.ai', allowB: e => e === 'ada@openathena.ai' })
    const bea = w.browser()
    await w.signInAtBroker(bea, 'bea@openathena.ai')
    expect(new URL((await bea.follow('https://a.test/auth/start?next=/home')).hops.at(-1)!).search).toBe('?sso=access_denied')

    const cy = w.browser()
    await w.signInAtBroker(cy, 'cy@openathena.ai')
    expect(new URL((await cy.follow('https://a.test/auth/start?next=/home')).hops.at(-1)!).pathname).toBe('/home')
    expect(new URL((await cy.follow('https://b.test/auth/start?next=/home')).hops.at(-1)!).search).toBe('?sso=access_denied')
    expect(await w.whoAt(cy, 'b.test')).toBe(null)
  })
})

describe('prompt and max_age', () => {
  it('prompt=login sends a signed-in person to sign in again, and an older session can\'t satisfy it', async () => {
    const w = await world()
    const b = w.browser()
    await w.signInAtBroker(b, 'ada@openathena.ai')
    const { challenge } = await pkce()
    at(10)
    const first = await b.request(authorizeUrl({ code_challenge: challenge, code_challenge_method: 'S256', prompt: 'login' }))
    const login = new URL(first.headers.get('location')!)
    expect(`${login.origin}${login.pathname}`).toBe('https://login.test/signin')
    expect(login.searchParams.get('prompt')).toBe('login')
    const next = new URL(login.searchParams.get('next')!, ISSUER)
    expect([next.searchParams.get('prompt'), next.searchParams.get('oa_login_after')]).toEqual([null, String(T0 / 1000 + 10)])

    // Back without signing in again: still the sign-in page.
    const again = await b.request(next.toString())
    expect(new URL(again.headers.get('location')!).pathname).toBe('/signin')

    at(20)
    await w.signInAtBroker(b, 'ada@openathena.ai')
    const done = await b.request(next.toString())
    const { to, params } = queryOf(done)
    expect([to, Object.keys(params).sort()]).toEqual(['https://a.test/auth/cb', ['code', 'iss', 'state']])
  })

  it('max_age past the sign-in is login_required when silent, and its auth_time is the sign-in\'s', async () => {
    const w = await world()
    const b = w.browser()
    await w.signInAtBroker(b, 'ada@openathena.ai')
    const { verifier, challenge } = await pkce()
    at(100)
    const stale = await b.request(authorizeUrl({ code_challenge: challenge, code_challenge_method: 'S256', prompt: 'none', max_age: '60' }))
    expect(queryOf(stale)).toEqual({ to: 'https://a.test/auth/cb', params: { error: 'login_required', state: 's1', iss: ISSUER } })

    const fresh = await b.request(authorizeUrl({ code_challenge: challenge, code_challenge_method: 'S256', prompt: 'none', max_age: '120' }))
    const code = queryOf(fresh).params.code!
    const res = await w.provider(tokenRequest({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: 'https://a.test/auth/cb', client_id: 'app-a', client_secret: 'app-a-secret' }))
    expect(claimsOf(((await res!.json()) as { id_token: string }).id_token).auth_time).toBe(T0 / 1000)
  })

  it('select_account goes to the chooser once, then on with whoever was chosen', async () => {
    const w = await world()
    const b = w.browser()
    await w.signInAtBroker(b, 'ada@openathena.ai')
    const { challenge } = await pkce()
    const res = await b.request(authorizeUrl({ code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account', login_hint: 'ada@openathena.ai' }))
    const chooser = new URL(res.headers.get('location')!)
    expect([chooser.pathname, chooser.searchParams.get('prompt'), chooser.searchParams.get('login_hint')]).toEqual(['/signin', 'select_account', 'ada@openathena.ai'])
    const back = await b.request(new URL(chooser.searchParams.get('next')!, ISSUER).toString())
    expect(Object.keys(queryOf(back).params).sort()).toEqual(['code', 'iss', 'state'])
  })
})

describe('a broker holding several accounts', () => {
  it('none selected: a choice is missing, not a sign-in', async () => {
    const w = await world({ retained: true })
    const b = w.browser()
    await w.signInAtBroker(b, 'ada@openathena.ai')
    await w.signInAtBroker(b, 'bea@openathena.ai')
    const cookie = () => [...b.jar('login.test')].map(([k, v]) => `${k}=${v}`).join('; ')
    const selection = await w.broker.retained!.selection(new Request(`${ISSUER}/x`, { headers: { cookie: cookie() } }), Date.now())
    await w.broker.retained!.select(new Request(`${ISSUER}/x`, { headers: { cookie: cookie(), [SELECTION_CONTEXT_HEADER]: selection! } }), null, Date.now())
    const { challenge } = await pkce()
    const s256 = { code_challenge: challenge, code_challenge_method: 'S256' }

    expect(queryOf(await b.request(authorizeUrl({ ...s256, prompt: 'none' }))).params.error).toBe('account_selection_required')
    const chooser = new URL((await b.request(authorizeUrl(s256))).headers.get('location')!)
    expect([chooser.pathname, chooser.searchParams.get('prompt')]).toEqual(['/signin', 'select_account'])
  })
})

describe('tokens', () => {
  it('the ID token and userinfo say exactly who, for whom, and nothing an app could forge', async () => {
    const w = await world()
    const b = w.browser()
    await w.signInAtBroker(b, 'ada@openathena.ai')
    const { verifier, challenge } = await pkce()
    const res = await b.request(authorizeUrl({ code_challenge: challenge, code_challenge_method: 'S256', nonce: 'n-1', scope: 'openid email profile groups unknown' }))
    const code = queryOf(res).params.code!
    const basic = `Basic ${btoa('app-a:app-a-secret')}`
    const tok = await w.provider(tokenRequest({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: 'https://a.test/auth/cb' }, { authorization: basic }))
    expect(tok!.status).toBe(200)
    expect(tok!.headers.get('cache-control')).toBe('no-store')
    const body = (await tok!.json()) as { access_token: string; id_token: string; token_type: string; expires_in: number; scope: string }
    expect([body.token_type, body.expires_in, body.scope]).toEqual(['Bearer', 300, 'openid email profile groups'])
    const sub = claimsOf(body.id_token).sub
    expect(typeof sub === 'string' && sub.length === 43).toBe(true)
    const nowS = T0 / 1000
    expect(claimsOf(body.id_token)).toEqual({
      groups: ['research'],
      email: 'ada@openathena.ai',
      email_verified: true,
      iss: ISSUER,
      sub,
      aud: 'app-a',
      iat: nowS,
      exp: nowS + 300,
      auth_time: nowS,
      nonce: 'n-1',
    })
    const ui = await w.provider(new Request(`${ISSUER}/oidc/userinfo`, { headers: { authorization: `Bearer ${body.access_token}` } }))
    expect(await ui!.json()).toEqual({ groups: ['research'], email: 'ada@openathena.ai', email_verified: true, sub })
    // The ID token isn't an access token, and the access token isn't an ID token.
    const wrong = await w.provider(new Request(`${ISSUER}/oidc/userinfo`, { headers: { authorization: `Bearer ${body.id_token}` } }))
    expect([wrong!.status, wrong!.headers.get('www-authenticate')]).toEqual([401, 'Bearer error="invalid_token"'])
  })

  it('a claims hook can\'t set a standard claim, even one the scope left out', async () => {
    const w = await world()
    const b = w.browser()
    await w.signInAtBroker(b, 'ada@openathena.ai')
    const { verifier, challenge } = await pkce()
    const res = await b.request(authorizeUrl({ code_challenge: challenge, code_challenge_method: 'S256', scope: 'openid groups' }))
    const tok = await w.provider(tokenRequest({ grant_type: 'authorization_code', code: queryOf(res).params.code!, code_verifier: verifier, redirect_uri: 'https://a.test/auth/cb', client_id: 'app-a', client_secret: 'app-a-secret' }))
    const claims = claimsOf(((await tok!.json()) as { id_token: string }).id_token)
    expect(Object.keys(claims).sort()).toEqual(['aud', 'auth_time', 'exp', 'groups', 'iat', 'iss', 'sub'])
  })

  it('the same person has the same sub at every app, and different people differ', async () => {
    const w = await world()
    const subs: string[] = []
    for (const [email, client, host] of [['ada@openathena.ai', 'app-a', 'a.test'], ['ada@openathena.ai', 'app-b', 'b.test'], ['bea@openathena.ai', 'app-a', 'a.test']] as const) {
      const b = w.browser()
      await w.signInAtBroker(b, email)
      const { verifier, challenge } = await pkce()
      const res = await b.request(authorizeUrl({ client_id: client, redirect_uri: `https://${host}/auth/cb`, code_challenge: challenge, code_challenge_method: 'S256' }))
      const tok = await w.provider(tokenRequest({ grant_type: 'authorization_code', code: queryOf(res).params.code!, code_verifier: verifier, redirect_uri: `https://${host}/auth/cb`, client_id: client, client_secret: `${client}-secret` }))
      subs.push(claimsOf(((await tok!.json()) as { id_token: string }).id_token).sub as string)
    }
    expect([subs[0] === subs[1], subs[0] === subs[2]]).toEqual([true, false])
  })

  it('discovery and JWKS', async () => {
    const w = await world()
    const d = (await (await w.provider(new Request(`${ISSUER}/.well-known/openid-configuration`)))!.json()) as Record<string, unknown>
    expect([d.issuer, d.authorization_endpoint, d.token_endpoint, d.jwks_uri, d.end_session_endpoint, d.code_challenge_methods_supported, d.scopes_supported]).toEqual([
      ISSUER,
      `${ISSUER}/oidc/authorize`,
      `${ISSUER}/oidc/token`,
      `${ISSUER}/oidc/jwks`,
      `${ISSUER}/oidc/logout`,
      ['S256'],
      ['openid', 'email', 'profile', 'groups'],
    ])
    const jwks = (await (await w.provider(new Request(`${ISSUER}/oidc/jwks`)))!.json()) as { keys: Record<string, unknown>[] }
    expect(jwks.keys.map(k => Object.keys(k).sort())).toEqual([['alg', 'e', 'kid', 'kty', 'n', 'use']])
  })
})

describe('refusals', () => {
  it('an unknown client or an unregistered redirect gets a page, never a redirect', async () => {
    const w = await world()
    const b = w.browser()
    await w.signInAtBroker(b, 'ada@openathena.ai')
    const { challenge } = await pkce()
    const cases: Record<string, string>[] = [
      { client_id: 'nope' },
      { redirect_uri: 'https://a.test/auth/cb/' },
      { redirect_uri: 'https://a.test/auth/cb?x=1' },
      { redirect_uri: 'https://evil.test/auth/cb' },
      { redirect_uri: 'https://b.test/auth/cb' },
      { redirect_uri: '' },
    ]
    for (const c of cases) {
      const res = await b.request(authorizeUrl({ code_challenge: challenge, code_challenge_method: 'S256', ...c }))
      expect([res.status, res.headers.get('location')]).toEqual([400, null])
    }
  })

  it('a malformed request goes back to the app as an error, with state and iss', async () => {
    const w = await world()
    const b = w.browser()
    await w.signInAtBroker(b, 'ada@openathena.ai')
    const { challenge } = await pkce()
    const errorOf = async (p: Record<string, string>) => queryOf(await b.request(authorizeUrl(p))).params
    const s256 = { code_challenge: challenge, code_challenge_method: 'S256' }
    expect(await errorOf({})).toEqual({ error: 'invalid_request', error_description: 'PKCE with code_challenge_method=S256 is required', state: 's1', iss: ISSUER })
    expect((await errorOf({ code_challenge: challenge, code_challenge_method: 'plain' })).error).toBe('invalid_request')
    expect((await errorOf({ code_challenge: challenge })).error).toBe('invalid_request')
    expect((await errorOf({ ...s256, response_type: 'token' })).error).toBe('unsupported_response_type')
    expect((await errorOf({ ...s256, scope: 'email' })).error).toBe('invalid_scope')
    expect((await errorOf({ ...s256, prompt: 'none login' })).error).toBe('invalid_request')
    expect((await errorOf({ ...s256, request: 'x' })).error).toBe('request_not_supported')
  })

  it('a repeated parameter is refused outright', async () => {
    const w = await world()
    const res = await w.provider(new Request(`${authorizeUrl({})}&client_id=app-b`))
    expect(res!.status).toBe(400)
  })

  it('a code works once, only for its client, redirect and verifier, and not after a minute', async () => {
    const w = await world()
    const b = w.browser()
    await w.signInAtBroker(b, 'ada@openathena.ai')
    const issue = async () => {
      const { verifier, challenge } = await pkce()
      const res = await b.request(authorizeUrl({ code_challenge: challenge, code_challenge_method: 'S256' }))
      return { code: queryOf(res).params.code!, verifier }
    }
    const exchange = async (form: Record<string, string>) => {
      const res = await w.provider(tokenRequest({ grant_type: 'authorization_code', redirect_uri: 'https://a.test/auth/cb', client_id: 'app-a', client_secret: 'app-a-secret', ...form }))
      return [res!.status, ((await res!.json()) as { error?: string }).error ?? 'ok']
    }

    const ok = await issue()
    expect(await exchange({ code: ok.code, code_verifier: ok.verifier })).toEqual([200, 'ok'])
    expect(await exchange({ code: ok.code, code_verifier: ok.verifier })).toEqual([400, 'invalid_grant'])

    // Any failed attempt spends the code: the right client can't use it after.
    const stolen = await issue()
    expect(await exchange({ code: stolen.code, code_verifier: stolen.verifier, client_id: 'app-b', client_secret: 'app-b-secret' })).toEqual([400, 'invalid_grant'])
    expect(await exchange({ code: stolen.code, code_verifier: stolen.verifier })).toEqual([400, 'invalid_grant'])

    const c1 = await issue()
    expect(await exchange({ code: c1.code, code_verifier: 'w'.repeat(43) })).toEqual([400, 'invalid_grant'])
    const c2 = await issue()
    expect(await exchange({ code: c2.code, code_verifier: c2.verifier, redirect_uri: 'https://a.test/auth/cb/' })).toEqual([400, 'invalid_grant'])
    const c3 = await issue()
    at(60)
    expect(await exchange({ code: c3.code, code_verifier: c3.verifier })).toEqual([400, 'invalid_grant'])
  })

  it('a client allowed to skip PKCE: without it, no verifier may follow; with it, the usual rules', async () => {
    const w = await world({ pkceOptionalA: true })
    const b = w.browser()
    await w.signInAtBroker(b, 'ada@openathena.ai')
    const issue = async (p: Record<string, string>) => queryOf(await b.request(authorizeUrl(p))).params
    const exchange = async (form: Record<string, string>) => {
      const res = await w.provider(tokenRequest({ grant_type: 'authorization_code', redirect_uri: 'https://a.test/auth/cb', client_id: 'app-a', client_secret: 'app-a-secret', ...form }))
      return [res!.status, ((await res!.json()) as { error?: string }).error ?? 'ok']
    }
    const { verifier, challenge } = await pkce()

    expect(await exchange({ code: (await issue({})).code! })).toEqual([200, 'ok'])
    // No challenge was sent, so a verifier can't be bolted on afterwards.
    expect(await exchange({ code: (await issue({})).code!, code_verifier: verifier })).toEqual([400, 'invalid_grant'])
    expect(await exchange({ code: (await issue({ code_challenge: challenge, code_challenge_method: 'S256' })).code! })).toEqual([400, 'invalid_grant'])
    expect(await exchange({ code: (await issue({ code_challenge: challenge, code_challenge_method: 'S256' })).code!, code_verifier: verifier })).toEqual([200, 'ok'])
    expect((await issue({ code_challenge: challenge, code_challenge_method: 'plain' })).error).toBe('invalid_request')
    expect((await issue({ code_challenge_method: 'S256' })).error).toBe('invalid_request')

    // Everyone else still must.
    const other = queryOf(await b.request(authorizeUrl({ client_id: 'app-b', redirect_uri: 'https://b.test/auth/cb' }))).params
    expect(other).toEqual({ error: 'invalid_request', error_description: 'PKCE with code_challenge_method=S256 is required', state: 's1', iss: ISSUER })
  })

  it('client authentication: a wrong secret, two methods at once, or none', async () => {
    const w = await world()
    const status = async (form: Record<string, string>, headers: Record<string, string> = {}) => {
      const res = await w.provider(tokenRequest({ grant_type: 'authorization_code', code: 'x', code_verifier: 'v'.repeat(43), ...form }, headers))
      return [res!.status, ((await res!.json()) as { error: string }).error, res!.headers.get('www-authenticate')]
    }
    expect(await status({ client_id: 'app-a', client_secret: 'wrong' })).toEqual([401, 'invalid_client', null])
    expect(await status({ client_id: 'app-a' })).toEqual([401, 'invalid_client', null])
    expect(await status({}, { authorization: `Basic ${btoa('app-a:wrong')}` })).toEqual([401, 'invalid_client', 'Basic realm="token"'])
    expect(await status({ client_secret: 'app-a-secret' }, { authorization: `Basic ${btoa('app-a:app-a-secret')}` })).toEqual([400, 'invalid_request', null])
    expect(await status({ client_id: 'app-a', client_secret: 'app-a-secret', grant_type: 'refresh_token' })).toEqual([400, 'unsupported_grant_type', null])
  })

  it('the relying party refuses an ID token signed by any other key', async () => {
    const ours = keySet([KEY])
    const theirs = keySet([OTHER_KEY])
    const forged = await theirs.sign({ iss: ISSUER, sub: 'x' })
    expect([await ours.verify(await ours.sign({ a: 1 })), await ours.verify(forged)]).toEqual([{ a: 1 }, null])
    const [h, p] = forged.split('.')
    const none = `${b64uEncode(enc.encode(JSON.stringify({ alg: 'none', kid: 'k1' })))}.${p}.`
    expect([await ours.verify(none), await ours.verify(`${h}.${p}`)]).toEqual([null, null])
  })
})

describe('logout', () => {
  it('with an ID token hint and a registered return: signed out at the broker, back to the app', async () => {
    const w = await world()
    const b = w.browser()
    await w.signInAtBroker(b, 'ada@openathena.ai')
    const { verifier, challenge } = await pkce()
    const res = await b.request(authorizeUrl({ code_challenge: challenge, code_challenge_method: 'S256' }))
    const tok = await w.provider(tokenRequest({ grant_type: 'authorization_code', code: queryOf(res).params.code!, code_verifier: verifier, redirect_uri: 'https://a.test/auth/cb', client_id: 'app-a', client_secret: 'app-a-secret' }))
    const { id_token } = (await tok!.json()) as { id_token: string }
    at(3600)
    const out = await b.request(`${ISSUER}/oidc/logout?${new URLSearchParams({ id_token_hint: id_token, post_logout_redirect_uri: 'https://a.test/bye', state: 'z' })}`)
    expect(out.headers.get('location')).toBe('https://a.test/bye?state=z')
    expect([...b.jar('login.test').keys()]).toEqual([])
  })

  it('an unregistered return address, or no hint: signed out, and no redirect', async () => {
    const w = await world()
    const b = w.browser()
    await w.signInAtBroker(b, 'ada@openathena.ai')
    const out = await b.request(`${ISSUER}/oidc/logout?post_logout_redirect_uri=${encodeURIComponent('https://evil.test/')}`)
    expect([out.status, out.headers.get('location'), await out.text()]).toEqual([200, null, 'Signed out.\n'])
    expect([...b.jar('login.test').keys()]).toEqual([])
  })
})

describe('d1ProviderStore', () => {
  const rec = (codeHash: string, expiresAt: number) => ({
    codeHash,
    clientId: 'app-a',
    redirectUri: 'https://a.test/auth/cb',
    challenge: 'c'.repeat(43),
    nonce: null,
    email: 'ada@openathena.ai',
    scope: 'openid email',
    authTime: 100,
    expiresAt,
  })

  it('takes a code once, refuses an expired one, and sweeps the expired', async () => {
    const { db, raw } = testDbRaw(['provider'])
    const s = d1ProviderStore(db, { cleanupChunk: 2 })
    for (const [h, exp] of [['live', 200], ['old1', 50], ['old2', 60], ['old3', 70]] as const) await s.putCode(rec(h, exp))
    expect([await s.takeCode('live', 150), await s.takeCode('live', 150)]).toEqual([rec('live', 200), null])
    expect(await s.takeCode('old1', 150)).toBe(null)
    expect([await s.cleanup(150), await s.cleanup(150)]).toEqual([2, 0])
    expect(raw.prepare('SELECT count(*) AS n FROM provider_codes').get()).toEqual({ n: 0 })
  })
})
