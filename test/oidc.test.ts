/**
 * The OIDC sign-in flow, with a fake issuer: a real RSA keypair generated per
 * suite, a JWKS endpoint serving its public half, and a token endpoint that
 * signs whatever id_token the test asks for.
 *
 * Faking the *provider* rather than the verification is the point — these
 * tests exercise the same `verifyRs256Jwt` a production sign-in runs, so a
 * signature check that stops checking fails here.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { GOOGLE, googleOneTapNonce, googleOneTapVerify, oidcCallback, oidcStart } from '../src/adapters/oidc.js'
import { createGate } from '../src/core/gate.js'
import { domainPolicy } from '../src/core/policy.js'
import { type MemoryProfileStore, memoryProfileStore } from '../src/testing/index.js'
import { memoryAudit, memoryStore } from './memory-store.js'

const SECRET = 'test-secret-0123456789abcdef'
const CLIENT_ID = 'client-123.apps.googleusercontent.com'
const REDIRECT = 'https://app.test/auth/google/callback'

let keys: CryptoKeyPair
let jwks: { keys: (JsonWebKey & { kid: string })[] }
let gate: ReturnType<typeof createGate>

const enc = new TextEncoder()

/** `Headers.getSetCookie` isn't in `@cloudflare/workers-types`, but exists at runtime. */
const setCookies = (res: Response): string[] => (res.headers as unknown as { getSetCookie(): string[] }).getSetCookie()
const b64u = (b: ArrayBuffer | Uint8Array): string => {
  const bytes = b instanceof Uint8Array ? b : new Uint8Array(b)
  let s = ''
  for (const c of bytes) s += String.fromCharCode(c)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** An id_token from our fake issuer, signed for real. */
async function idToken(claims: Record<string, unknown>, kid = 'test-key'): Promise<string> {
  const header = b64u(enc.encode(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' })))
  const payload = b64u(
    enc.encode(
      JSON.stringify({
        iss: 'https://accounts.google.com',
        aud: CLIENT_ID,
        exp: Math.floor(Date.now() / 1000) + 300,
        ...claims,
      }),
    ),
  )
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, enc.encode(`${header}.${payload}`))
  return `${header}.${payload}.${b64u(sig)}`
}

/** Answers the provider's JWKS and token endpoints; everything else 404s. */
function providerFetch(token: string | null) {
  return (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url === GOOGLE.jwksUrl) return Response.json(jwks)
    if (url === GOOGLE.tokenUrl) {
      return token ? Response.json({ id_token: token }) : new Response('nope', { status: 400 })
    }
    return new Response(null, { status: 404 })
  }) as typeof globalThis.fetch
}

beforeAll(async () => {
  keys = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair
  const jwk = (await crypto.subtle.exportKey('jwk', keys.publicKey)) as JsonWebKey
  jwks = { keys: [{ ...jwk, kid: 'test-key' } as JsonWebKey & { kid: string }] }
})

beforeEach(() => {
  gate = createGate({
    store: memoryStore(),
    audit: memoryAudit(),
    secret: SECRET,
    adminEmails: ['boss@openathena.ai'],
    policy: domainPolicy(['openathena.ai'], ['internal']),
  })
})

const opts = (fetch: typeof globalThis.fetch) => ({
  gate,
  clientId: CLIENT_ID,
  clientSecret: 'shh',
  redirectUri: REDIRECT,
  fetch,
})

/** Walk the redirect: returns the state and the nonce cookie the browser got. */
async function start(next = '/reports'): Promise<{ state: string; cookie: string }> {
  const res = await oidcStart(opts(providerFetch(null)))({
    request: new Request(`https://app.test/auth/google?next=${encodeURIComponent(next)}`),
  })
  const location = new URL(res.headers.get('location')!)
  const setCookie = res.headers.get('set-cookie')!
  return { state: location.searchParams.get('state')!, cookie: setCookie.split(';')[0]! }
}

const callback = (state: string, cookie: string | null, token: string | null) =>
  oidcCallback(opts(providerFetch(token)))({
    request: new Request(`https://app.test/auth/google/callback?code=abc&state=${encodeURIComponent(state)}`, {
      headers: cookie ? { Cookie: cookie } : {},
    }),
  })

describe('oidcStart', () => {
  it('sends the browser to the provider with everything the flow needs', async () => {
    const res = await oidcStart(opts(providerFetch(null)))({
      request: new Request('https://app.test/auth/google?next=%2Freports'),
    })
    const url = new URL(res.headers.get('location')!)
    const p = url.searchParams
    expect([res.status, `${url.origin}${url.pathname}`, p.get('client_id'), p.get('redirect_uri'), p.get('response_type'), p.get('scope')]).toEqual([
      302,
      GOOGLE.authUrl,
      CLIENT_ID,
      REDIRECT,
      'code',
      'openid email profile',
    ])
    // The nonce is in the URL *and* in a cookie — that pairing is the CSRF defence.
    expect(res.headers.get('set-cookie')).toContain(`oa_oidc=${p.get('nonce')}`)
  })

  it('collapses an off-site `next` to `/` before signing it into the state', async () => {
    // Otherwise `?next=` is an open redirect with our signature on it — and the
    // signature is what would make it *convincing*.
    const subjectOf = (state: string): string => {
      const body = state.slice(0, state.indexOf('.')).replace(/-/g, '+').replace(/_/g, '/')
      return (JSON.parse(atob(body)) as { sub: string }).sub
    }
    const [offsite, protocolRelative, ok] = await Promise.all([
      start('https://evil.test/steal'),
      start('//evil.test/steal'),
      start('/reports'),
    ])
    expect([subjectOf(offsite.state), subjectOf(protocolRelative.state), subjectOf(ok.state)].map(sub => sub.slice(sub.indexOf(':', 5) + 1))).toEqual([
      '/',
      '/',
      '/reports',
    ])
  })
})

describe('oidcCallback', () => {
  it('signs in a verified address and lands on the requested path', async () => {
    const { state, cookie } = await start('/reports')
    const nonce = cookie.split('=')[1]!
    const res = await callback(state, cookie, await idToken({ email: 'staff@openathena.ai', email_verified: true, nonce }))

    const cookies = setCookies(res)
    expect([res.status, res.headers.get('location')]).toEqual([302, '/reports'])
    expect(cookies.some(c => c.startsWith('oa_auth='))).toBe(true)
    // The nonce cookie is spent, and cleared rather than left to expire.
    expect(cookies.some(c => c.startsWith('oa_oidc=') && c.includes('Max-Age=0'))).toBe(true)
  })

  it('refuses a state that was issued to a different browser', async () => {
    // Login-CSRF: the attacker runs the flow themselves, then feeds their own
    // (perfectly well-signed) state to the victim. Without the cookie check the
    // victim is silently signed in as the attacker.
    const attacker = await start('/reports')
    const nonce = attacker.cookie.split('=')[1]!
    const token = await idToken({ email: 'staff@openathena.ai', email_verified: true, nonce })

    const withoutCookie = await callback(attacker.state, null, token)
    const withOtherCookie = await callback(attacker.state, 'oa_oidc=some-other-nonce', token)
    expect([withoutCookie.status, withOtherCookie.status]).toEqual([400, 400])
  })

  it('refuses an id_token answering someone else’s nonce', async () => {
    const { state, cookie } = await start()
    const res = await callback(state, cookie, await idToken({ email: 'staff@openathena.ai', email_verified: true, nonce: 'replayed' }))
    expect(res.status).toBe(400)
  })

  it('refuses an unverified address', async () => {
    const { state, cookie } = await start()
    const nonce = cookie.split('=')[1]!
    const res = await callback(state, cookie, await idToken({ email: 'staff@openathena.ai', email_verified: false, nonce }))
    expect(res.status).toBe(400)
  })

  it('refuses a token signed by a key the provider does not publish', async () => {
    const { state, cookie } = await start()
    const nonce = cookie.split('=')[1]!
    // Right claims, right shape, wrong `kid` — so no published key matches.
    const res = await callback(state, cookie, await idToken({ email: 'staff@openathena.ai', email_verified: true, nonce }, 'other-key'))
    expect(res.status).toBe(400)
  })

  it('refuses a token minted for a different client', async () => {
    const { state, cookie } = await start()
    const nonce = cookie.split('=')[1]!
    const res = await callback(state, cookie, await idToken({ email: 'staff@openathena.ai', email_verified: true, nonce, aud: 'someone-else' }))
    expect(res.status).toBe(400)
  })

  it('separates "who you are" from "may you in": a verified stranger is bounced, not signed in', async () => {
    const { state, cookie } = await start()
    const nonce = cookie.split('=')[1]!
    const res = await callback(state, cookie, await idToken({ email: 'stranger@example.com', email_verified: true, nonce }))

    // A 302 carrying the *verified* address, so the app can pre-fill a
    // request-access form with an address Google vouched for rather than one
    // the visitor typed.
    expect([res.status, res.headers.get('location')]).toEqual([302, '/?denied=stranger%40example.com'])
    expect(setCookies(res).some(c => c.startsWith('oa_auth='))).toBe(false)
  })

  it('refuses a state that is merely a valid session cookie', async () => {
    // The two token types share a secret and must stay mutually inert.
    const signedIn = await gate.signIn('staff@openathena.ai', new Request('https://app.test/'))
    const sessionValue = signedIn!.cookie.split(';')[0]!.split('=')[1]!
    const res = await callback(sessionValue, 'oa_oidc=whatever', null)
    expect(res.status).toBe(400)
  })

  it('pins the algorithm rather than believing the header', async () => {
    // A genuine RS256 signature under a header that *claims* HS256. The header
    // is part of the signed input, so the signature verifies — meaning without
    // the `alg` pin this token is accepted on the strength of a claim it makes
    // about itself. That is the shape of every JWT algorithm-confusion bug.
    const { state, cookie } = await start()
    const nonce = cookie.split('=')[1]!
    const header = b64u(enc.encode(JSON.stringify({ alg: 'HS256', kid: 'test-key', typ: 'JWT' })))
    const payload = b64u(
      enc.encode(
        JSON.stringify({
          iss: 'https://accounts.google.com',
          aud: CLIENT_ID,
          exp: Math.floor(Date.now() / 1000) + 300,
          email: 'staff@openathena.ai',
          email_verified: true,
          nonce,
        }),
      ),
    )
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, enc.encode(`${header}.${payload}`))
    expect((await callback(state, cookie, `${header}.${payload}.${b64u(sig)}`)).status).toBe(400)
  })

  it('mints a state that is inert as a session cookie', async () => {
    // This is the direction that matters: a state is handed to the browser, so
    // if it doubled as a session it would be a free sign-in. Two independent
    // things stop it, and mutating either one alone leaves this passing —
    // `parseSub` accepts only `e:`/`g:` subjects, and even read as a grant,
    // no grant exists whose id is a nonce. Defence in depth, so stated as
    // such rather than credited to one guard.
    const { state } = await start()
    const auth = await gate.authenticate(new Request('https://app.test/', { headers: { Cookie: `oa_auth=${state}` } }))
    expect(auth).toBe(null)
  })

  it('refuses a callback with no code at all', async () => {
    const res = await oidcCallback(opts(providerFetch(null)))({
      request: new Request('https://app.test/auth/google/callback'),
    })
    expect(res.status).toBe(400)
  })
})

describe('PKCE and provider errors', () => {
  it('sends an S256 challenge, and the callback proves it with the matching verifier', async () => {
    const res = await oidcStart(opts(providerFetch(null)))({ request: new Request('https://app.test/auth/google?next=%2Freports') })
    const p = new URL(res.headers.get('location')!).searchParams
    const nonce = res.headers.get('set-cookie')!.split(';')[0]!.split('=')[1]!
    expect(p.get('code_challenge_method')).toBe('S256')

    let tokenForm: URLSearchParams | null = null
    const token = await idToken({ email: 'staff@openathena.ai', email_verified: true, nonce })
    const capture = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === GOOGLE.tokenUrl) tokenForm = new URLSearchParams(String(init!.body))
      return providerFetch(token)(input, init)
    }) as typeof globalThis.fetch
    const cb = await oidcCallback(opts(capture))({
      request: new Request(`https://app.test/auth/google/callback?code=abc&state=${encodeURIComponent(p.get('state')!)}`, { headers: { Cookie: `oa_oidc=${nonce}` } }),
    })
    expect(cb.headers.get('location')).toBe('/reports')
    const verifier = tokenForm!.get('code_verifier')!
    const digest = await crypto.subtle.digest('SHA-256', enc.encode(verifier))
    expect([/^[A-Za-z0-9_-]{43}$/.test(verifier), b64u(digest)]).toEqual([true, p.get('code_challenge')])
  })

  it('`?prompt=none` asks for a silent attempt, and `?account=choose` still wins', async () => {
    const prompt = async (q: string) =>
      new URL((await oidcStart(opts(providerFetch(null)))({ request: new Request(`https://app.test/auth/google?${q}`) })).headers.get('location')!).searchParams.get('prompt')
    expect([await prompt('prompt=none'), await prompt('account=choose&prompt=none'), await prompt('')]).toEqual(['none', 'select_account', null])
  })

  it('a provider error with our state goes back to `next` with the reason, and spends the nonce', async () => {
    const { state, cookie } = await start('/reports?tab=2')
    const cb = (error: string) =>
      oidcCallback(opts(providerFetch(null)))({
        request: new Request(`https://app.test/auth/google/callback?error=${error}&state=${encodeURIComponent(state)}`, { headers: { Cookie: cookie } }),
      })
    const res = await cb('login_required')
    expect([res.status, res.headers.get('location')]).toEqual([302, '/reports?tab=2&sso=login_required'])
    expect(setCookies(res).map(c => c.split(';')[0])).toEqual(['oa_oidc='])
    expect((await cb('server_error')).headers.get('location')).toBe('/reports?tab=2&sso=error')
  })

  it('a provider error with a state from another browser is refused like any other', async () => {
    const { state } = await start()
    const res = await oidcCallback(opts(providerFetch(null)))({
      request: new Request(`https://app.test/auth/google/callback?error=login_required&state=${encodeURIComponent(state)}`, { headers: { Cookie: 'oa_oidc=other' } }),
    })
    expect([res.status, res.headers.get('location')]).toEqual([400, null])
  })
})

describe('hostedDomain', () => {
  const hosted = async (hd: string | undefined) => {
    const { state, cookie } = await start('/reports')
    const nonce = cookie.split('=')[1]!
    const token = await idToken({ email: 'staff@openathena.ai', email_verified: true, nonce, ...(hd ? { hd } : {}) })
    const res = await oidcCallback({ ...opts(providerFetch(token)), hostedDomain: 'openathena.ai' })({
      request: new Request(`https://app.test/auth/google/callback?code=abc&state=${encodeURIComponent(state)}`, { headers: { Cookie: cookie } }),
    })
    return [res.headers.get('location'), setCookies(res).some(c => c.startsWith('oa_auth='))]
  }

  it('admits a managed Workspace account, and denies a consumer account at the same address or another domain', async () => {
    expect(await hosted('openathena.ai')).toEqual(['/reports', true])
    expect(await hosted(undefined)).toEqual(['/?denied=staff%40openathena.ai', false])
    expect(await hosted('example.com')).toEqual(['/?denied=staff%40openathena.ai', false])
  })
})

describe('googleOneTap', () => {
  /** A fresh HMAC-signed nonce, as the page would fetch from `googleOneTapNonce`. */
  async function mintNonce(): Promise<string> {
    const res = await googleOneTapNonce({ gate })()
    return ((await res.json()) as { nonce: string }).nonce
  }

  const verify = (credential: string, nonce: string) =>
    googleOneTapVerify({ gate, clientId: CLIENT_ID, fetch: providerFetch(null) })({
      request: new Request('https://app.test/auth/google/onetap', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ credential, nonce }),
      }),
    })

  it('mints a nonce that is inert as a session cookie', async () => {
    // Handed to the browser, so it must not double as a sign-in — same property
    // as the redirect `state`.
    const nonce = await mintNonce()
    const auth = await gate.authenticate(new Request('https://app.test/', { headers: { Cookie: `oa_auth=${nonce}` } }))
    expect(auth).toBe(null)
  })

  it('signs in a verified, allowed identity carrying our nonce', async () => {
    const nonce = await mintNonce()
    const res = await verify(await idToken({ email: 'staff@openathena.ai', email_verified: true, nonce }), nonce)
    expect([res.status, ((await res.json()) as { ok: boolean }).ok]).toEqual([200, true])
    expect(setCookies(res).some(c => c.startsWith('oa_auth='))).toBe(true)
  })

  it('bounces a verified stranger with the address, and mints nothing', async () => {
    const nonce = await mintNonce()
    const res = await verify(await idToken({ email: 'stranger@example.com', email_verified: true, nonce }), nonce)
    expect([res.status, await res.json()]).toEqual([401, { ok: false, denied: 'stranger@example.com' }])
    expect(setCookies(res).some(c => c.startsWith('oa_auth='))).toBe(false)
  })

  it('refuses an unverified address', async () => {
    const nonce = await mintNonce()
    const res = await verify(await idToken({ email: 'staff@openathena.ai', email_verified: false, nonce }), nonce)
    expect(res.status).toBe(401)
    expect(setCookies(res).some(c => c.startsWith('oa_auth='))).toBe(false)
  })

  it('refuses a credential minted for a different client', async () => {
    const nonce = await mintNonce()
    const res = await verify(
      await idToken({ email: 'staff@openathena.ai', email_verified: true, nonce, aud: 'someone-else' }),
      nonce,
    )
    expect(res.status).toBe(401)
  })

  it('refuses a credential answering a different nonce', async () => {
    const nonce = await mintNonce()
    const res = await verify(await idToken({ email: 'staff@openathena.ai', email_verified: true, nonce: 'other' }), nonce)
    expect(res.status).toBe(401)
  })

  it('refuses a nonce we never minted', async () => {
    const res = await verify(await idToken({ email: 'staff@openathena.ai', email_verified: true, nonce: 'forged' }), 'forged')
    expect(res.status).toBe(401)
  })

  it('keeps a denial opaque by default, and names the reason only with debug', async () => {
    const nonce = await mintNonce()
    const cred = await idToken({ email: 'staff@openathena.ai', email_verified: false, nonce })

    // Default: a bare 401, no reason header — the same opacity as `oidcCallback`.
    const opaque = await verify(cred, nonce)
    expect([opaque.status, opaque.headers.get('x-onetap-reason')]).toEqual([401, null])

    // `debug: true` surfaces the reason for wiring diagnosis.
    const shown = await googleOneTapVerify({ gate, clientId: CLIENT_ID, debug: true, fetch: providerFetch(null) })({
      request: new Request('https://app.test/auth/google/onetap', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ credential: cred, nonce }),
      }),
    })
    expect([shown.status, shown.headers.get('x-onetap-reason')]).toEqual([401, 'no verified email'])
  })
})

/**
 * `seedProfile`: capture the name + face the id_token already carries into the
 * `profiles` table, once, without ever overriding a self-set profile. Both the
 * gate method and its wiring into the two sign-in handlers.
 */
describe('remembered account', () => {
  const HINT = 'oa_google_hint=staff%40openathena.ai'
  /** The cookie pairs (`name=value`, attributes dropped) a response sets. */
  const pairs = (res: Response) => setCookies(res).map(c => c.split(';')[0]!)
  /** The provider params `oidcStart` sends, for a request carrying `cookie` at `path`. */
  async function startParams(path: string, cookie: string | null, extra: object = {}) {
    const res = await oidcStart({ ...opts(providerFetch(null)), ...extra })({
      request: new Request(`https://app.test${path}`, { headers: cookie ? { Cookie: cookie } : {} }),
    })
    const p = new URL(res.headers.get('location')!).searchParams
    return [p.get('login_hint'), p.get('prompt')]
  }
  const history = (emails: unknown[], name = 'oa_google_hint') => `${name}_accounts=${encodeURIComponent(JSON.stringify(emails))}`
  async function hints(cookie = '', extra: object = {}) {
    const res = await googleOneTapNonce({ gate, ...extra })({ request: new Request('https://app.test/n', { headers: { Cookie: cookie } }) })
    const { nonce, ...body } = await res.json() as { nonce: string; loginHint?: string; loginHints?: string[] }
    expect(typeof nonce).toBe('string')
    return body
  }
  async function signInVia(email: string, extra: object = {}, remembered = '') {
    const { state, cookie } = await start()
    const nonce = cookie.split('=')[1]!
    return oidcCallback({ ...opts(providerFetch(await idToken({ email, email_verified: true, nonce }))), ...extra })({
      request: new Request(`https://app.test/auth/google/callback?code=abc&state=${encodeURIComponent(state)}`, {
        headers: { Cookie: `${cookie}; ${remembered}` },
      }),
    })
  }

  it('remembers the account a redirect sign-in used, past the session, and hints it on the next start', async () => {
    const res = await signInVia('staff@openathena.ai')
    expect(setCookies(res).filter(c => c.startsWith('oa_google_hint='))).toEqual([
      'oa_google_hint=staff%40openathena.ai; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=34560000',
    ])
    expect(await startParams('/auth/google', HINT)).toEqual(['staff@openathena.ai', null])
  })

  it('asks for the chooser instead with `?account=choose`, the "use another account" escape', async () => {
    expect(await startParams('/auth/google?account=choose', HINT)).toEqual([null, 'select_account'])
  })

  it('hints nothing with no cookie, or a cookie that is not an address', async () => {
    expect([await startParams('/auth/google', null), await startParams('/auth/google', 'oa_google_hint=nope')]).toEqual([
      [null, null],
      [null, null],
    ])
  })

  it('forgets the account when a sign-in is denied, so the next start shows the chooser', async () => {
    const res = await signInVia('stranger@example.com')
    expect(pairs(res)).toEqual(['oa_oidc=', 'oa_google_hint=', 'oa_google_hint_accounts='])
  })

  it('does none of it with `accountHintCookie: false`', async () => {
    const res = await signInVia('staff@openathena.ai', { accountHintCookie: false })
    expect(pairs(res).map(c => c.split('=')[0])).toEqual(['oa_auth', 'oa_oidc'])
    expect(await startParams('/auth/google', HINT, { accountHintCookie: false })).toEqual([null, null])
  })

  it('One Tap remembers its account too, and the nonce endpoint reports it for "not you?"', async () => {
    const nonceRes = await googleOneTapNonce({ gate })({ request: new Request('https://app.test/n') })
    const { nonce } = (await nonceRes.json()) as { nonce: string }
    const res = await googleOneTapVerify({ gate, clientId: CLIENT_ID, fetch: providerFetch(null) })({
      request: new Request('https://app.test/auth/google/onetap', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ credential: await idToken({ email: 'staff@openathena.ai', email_verified: true, nonce }), nonce }),
      }),
    })
    expect(pairs(res).slice(1)).toEqual([HINT, history(['staff@openathena.ai'])])

    const next = await googleOneTapNonce({ gate })({ request: new Request('https://app.test/n', { headers: { Cookie: HINT } }) })
    const { nonce: nextNonce, ...body } = (await next.json()) as { nonce: string; loginHint?: string; loginHints?: string[] }
    expect(typeof nextNonce).toBe('string')
    expect(body).toEqual({ loginHint: 'staff@openathena.ai', loginHints: ['staff@openathena.ai'] })
  })

  it('One Tap forgets a denied account', async () => {
    const nonceRes = await googleOneTapNonce({ gate })()
    const { nonce } = (await nonceRes.json()) as { nonce: string }
    const res = await googleOneTapVerify({ gate, clientId: CLIENT_ID, fetch: providerFetch(null) })({
      request: new Request('https://app.test/auth/google/onetap', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ credential: await idToken({ email: 'stranger@example.com', email_verified: true, nonce }), nonce }),
      }),
    })
    expect([res.status, pairs(res)]).toEqual([401, ['oa_google_hint=', 'oa_google_hint_accounts=']])
  })

  it('merges redirect successes in normalized MRU order, deduplicates and evicts the sixth account', async () => {
    const res = await signInVia('staff@openathena.ai', {}, history([
      'one@openathena.ai', 'STAFF@openathena.ai', 'two@openathena.ai', 'three@openathena.ai', 'four@openathena.ai', 'five@openathena.ai',
    ]))
    expect(res.status).toBe(302)
    expect(pairs(res).slice(2)).toEqual([HINT, history([
      'staff@openathena.ai', 'one@openathena.ai', 'two@openathena.ai', 'three@openathena.ai', 'four@openathena.ai',
    ])])
    expect(setCookies(res).slice(2).map(c => c.slice(c.indexOf(';')))).toEqual([
      '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=34560000',
      '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=34560000',
    ])
  })

  it('selects only remembered accounts and preserves the chooser escape', async () => {
    const cookie = `${HINT}; ${history(['other@openathena.ai', 'staff@openathena.ai'])}`
    expect(await startParams('/auth/google?account=OTHER%40openathena.ai', cookie)).toEqual(['other@openathena.ai', null])
    expect(await startParams('/auth/google?account=unknown%40example.com', cookie)).toEqual([null, null])
    expect(await startParams('/auth/google?account=choose', cookie)).toEqual([null, 'select_account'])
    expect(await startParams('/auth/google?account=staff%40openathena.ai', HINT)).toEqual(['staff@openathena.ai', null])
    expect(await startParams('/auth/google?account=staff%40openathena.ai', cookie, { accountHintCookie: false })).toEqual([null, null])
  })

  it('reports history without inventing a current hint or an authenticated session', async () => {
    const cookie = history(['one@example.com', 'two@example.com'])
    expect(await hints(cookie)).toEqual({ loginHints: ['one@example.com', 'two@example.com'] })
    expect(await gate.authenticate(new Request('https://app.test/', { headers: { Cookie: cookie } }))).toBeNull()
    expect(await hints()).toEqual({})
    expect(await hints(`${HINT}; ${cookie}`, { accountHintCookie: false })).toEqual({})
    expect(await hints(history([' OTHER@example.com '], 'custom'), { accountHintCookie: 'custom' })).toEqual({ loginHints: ['other@example.com'] })
    expect(await hints('oa_google_hint=STAFF%40openathena.ai')).toEqual({ loginHint: 'staff@openathena.ai', loginHints: ['staff@openathena.ai'] })
  })

  it('does not trust remembered hints in place of provider authentication', async () => {
    const cookie = `${HINT}; ${history(['staff@openathena.ai'])}`
    const res = await googleOneTapVerify({ gate, clientId: CLIENT_ID, fetch: providerFetch(null) })({
      request: new Request('https://app.test/auth/google/onetap', {
        method: 'POST', headers: { Cookie: cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ credential: 'forged', nonce: 'forged' }),
      }),
    })
    expect([res.status, await res.json(), pairs(res)]).toEqual([401, { ok: false }, []])
  })

  it.each(['%', '%5B', encodeURIComponent('{}'), encodeURIComponent('null'), 'x'.repeat(3001)])('ignores malformed or oversized history %s', async raw => {
    expect(await hints(`oa_google_hint_accounts=${raw}`)).toEqual({})
    expect(await hints(`${HINT}; oa_google_hint_accounts=${raw}`)).toEqual({ loginHint: 'staff@openathena.ai', loginHints: ['staff@openathena.ai'] })
  })

  it('validates entries, normalizes duplicates and limits email length', async () => {
    const maxEmail = `${'a'.repeat(242)}@example.com`
    expect(maxEmail.length).toBe(254)
    expect(await hints(history([null, 42, {}, 'bad', 'a@@example.com', 'a b@example.com', 'a\n@example.com', `${'a'.repeat(243)}@example.com`, ' ONE@example.com ', 'one@example.com', maxEmail]))).toEqual({
      loginHints: ['one@example.com', maxEmail],
    })
    expect(await hints(`oa_google_hint=${encodeURIComponent('a'.repeat(255) + '@example.com')}`)).toEqual({})
  })

  it('bounds encoded history even for maximally escaped addresses', async () => {
    const emails = Array.from({ length: 5 }, (_, i) => `${'%'.repeat(235)}${i}@openathena.ai`)
    const res = await signInVia(emails[0]!, {}, history(emails.slice(1)))
    const written = pairs(res).slice(2)
    expect(written).toEqual([
      `oa_google_hint=${encodeURIComponent(emails[0]!)}`,
      history(emails.slice(0, 4)),
    ])
    expect(written[1]!.split('=')[1]!.length).toBeLessThanOrEqual(3000)
    expect(await hints(history(emails))).toEqual({})
  })

  it.each(['redirect', 'onetap'])('%s merges successes and removes only the denied account', async flow => {
    const run = async (email: string, cookie: string, extra: object = {}) => {
      if (flow === 'redirect') return signInVia(email, extra, cookie)
      const nonceRes = await googleOneTapNonce({ gate })()
      const { nonce } = await nonceRes.json() as { nonce: string }
      return googleOneTapVerify({ gate, clientId: CLIENT_ID, fetch: providerFetch(null), ...extra })({
        request: new Request('https://app.test/auth/google/onetap', {
          method: 'POST',
          headers: { Cookie: cookie, 'content-type': 'application/json' },
          body: JSON.stringify({ credential: await idToken({ email, email_verified: true, nonce }), nonce }),
        }),
      })
    }
    const cookie = `oa_google_hint=stranger%40example.com; ${history(['stranger@example.com', 'other@openathena.ai', 'staff@openathena.ai'])}`
    const success = await run('staff@openathena.ai', cookie)
    expect(pairs(success).slice(flow === 'redirect' ? 2 : 1)).toEqual([HINT, history(['staff@openathena.ai', 'stranger@example.com', 'other@openathena.ai'])])
    const denied = await run('STRANGER@example.com', cookie)
    expect(pairs(denied)).toEqual([
      ...(flow === 'redirect' ? ['oa_oidc='] : []),
      'oa_google_hint=other%40openathena.ai', history(['other@openathena.ai', 'staff@openathena.ai']),
    ])
    const unrelated = await run('unknown@example.com', `${HINT}; ${history(['staff@openathena.ai', 'other@openathena.ai'])}`)
    expect(pairs(unrelated).slice(flow === 'redirect' ? 1 : 0)).toEqual([HINT, history(['staff@openathena.ai', 'other@openathena.ai'])])
    const disabled = await run('stranger@example.com', cookie, { accountHintCookie: false })
    expect(pairs(disabled)).toEqual(flow === 'redirect' ? ['oa_oidc='] : [])
    const disabledSuccess = await run('staff@openathena.ai', cookie, { accountHintCookie: false })
    expect(pairs(disabledSuccess).map(pair => pair.split('=')[0])).toEqual(flow === 'redirect' ? ['oa_auth', 'oa_oidc'] : ['oa_auth'])
    const custom = await run('staff@openathena.ai', history(['other@openathena.ai'], 'custom'), { accountHintCookie: 'custom' })
    expect(pairs(custom).slice(flow === 'redirect' ? 2 : 1)).toEqual(['custom=staff%40openathena.ai', history(['staff@openathena.ai', 'other@openathena.ai'], 'custom')])
  })
})

describe('profile seed', () => {
  const PICTURE = 'https://pics.test/face.png'
  /** A real 1×1 PNG: the copy sniffs the header, so the signature alone won't pass. */
  const PNG = Uint8Array.from(
    atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='),
    c => c.charCodeAt(0),
  )
  const dataUri = `data:image/png;base64,${btoa(String.fromCharCode(...PNG))}`

  /** The *gate's* fetch (avatar copy), distinct from the adapter's (JWKS/token). */
  const pictureFetch =
    (status = 200, type = 'image/png', bytes: Uint8Array = PNG): typeof globalThis.fetch =>
    (async input =>
      String(input) === PICTURE
        ? status === 200
          ? new Response(bytes, { headers: { 'content-type': type } })
          : new Response('x', { status })
        : new Response(null, { status: 404 })) as typeof globalThis.fetch

  const seedGate = (o: { profiles?: MemoryProfileStore | null; fetch?: typeof globalThis.fetch; timeoutMs?: number } = {}) => {
    const profiles = o.profiles === undefined ? memoryProfileStore() : o.profiles
    const g = createGate({
      store: memoryStore(),
      audit: memoryAudit(),
      secret: SECRET,
      adminEmails: ['boss@openathena.ai'],
      policy: domainPolicy(['openathena.ai'], ['internal']),
      fetch: o.fetch ?? pictureFetch(),
      ...(profiles ? { profiles } : {}),
      ...(o.timeoutMs !== undefined ? { avatarFetchTimeoutMs: o.timeoutMs } : {}),
    })
    return { g, profiles }
  }

  const norm = (p: Awaited<ReturnType<MemoryProfileStore['get']>>) => (p ? { ...p, updatedAt: '<ts>' } : null)

  describe('gate.seedProfileFromClaims', () => {
    it('seeds the display name whole, and the inlined avatar', async () => {
      const { g, profiles } = seedGate()
      const subject = await g.seedProfileFromClaims('ada@openathena.ai', { name: 'Ada Lovelace', picture: PICTURE })
      expect(subject).toEqual({ name: 'Ada Lovelace', avatar: dataUri })
      expect(norm(await profiles!.get('ada@openathena.ai'))).toEqual({
        email: 'ada@openathena.ai',
        name: 'Ada Lovelace',
        avatar: dataUri,
        avatarSrc: 'url',
        updatedAt: '<ts>',
      })
    })

    it('prefers the display name over given_name/family_name, and tolerates no picture', async () => {
      const { g, profiles } = seedGate()
      // The IdP's `name` is the person's own ordering (e.g. family-first); the
      // parts are only a fallback.
      await g.seedProfileFromClaims('ada@openathena.ai', { name: 'Lovelace Ada', given_name: 'Ada', family_name: 'Lovelace' })
      expect(norm(await profiles!.get('ada@openathena.ai'))).toEqual({
        email: 'ada@openathena.ai',
        name: 'Lovelace Ada',
        avatar: null,
        avatarSrc: null,
        updatedAt: '<ts>',
      })
    })

    it('joins given_name/family_name when there is no display name', async () => {
      const { g, profiles } = seedGate()
      await g.seedProfileFromClaims('ada@openathena.ai', { given_name: 'Ada', family_name: 'Lovelace' })
      await g.seedProfileFromClaims('cher@openathena.ai', { given_name: 'Cher' })
      expect([
        (await profiles!.get('ada@openathena.ai'))?.name,
        (await profiles!.get('cher@openathena.ai'))?.name,
      ]).toEqual(['Ada Lovelace', 'Cher'])
    })

    it('never overrides a self-set profile — a later sign-in is a no-op', async () => {
      const { g, profiles } = seedGate()
      const self = { email: 'ada@openathena.ai', name: 'Self Chosen', avatar: null, avatarSrc: null, updatedAt: 5 }
      await profiles!.put(self)
      await g.seedProfileFromClaims('ada@openathena.ai', { name: 'Google Name', picture: PICTURE })
      expect(await profiles!.get('ada@openathena.ai')).toEqual(self)
    })

    it('degrades to name-only when the avatar fetch fails, never throwing', async () => {
      const { g, profiles } = seedGate({ fetch: pictureFetch(500) })
      await g.seedProfileFromClaims('ada@openathena.ai', { name: 'Ada Lovelace', picture: PICTURE })
      expect(norm(await profiles!.get('ada@openathena.ai'))).toEqual({
        email: 'ada@openathena.ai',
        name: 'Ada Lovelace',
        avatar: null,
        avatarSrc: null,
        updatedAt: '<ts>',
      })
    })

    it('aborts a hanging avatar fetch at the timeout and stores name-only', async () => {
      const hanging: typeof globalThis.fetch = (async (_input, init) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve(new Response(PNG, { headers: { 'content-type': 'image/png' } })), 1000)
          ;(init?.signal as AbortSignal | undefined)?.addEventListener('abort', () => {
            clearTimeout(timer)
            reject(new Error('aborted'))
          })
        })) as typeof globalThis.fetch
      const { g, profiles } = seedGate({ fetch: hanging, timeoutMs: 10 })
      await g.seedProfileFromClaims('ada@openathena.ai', { name: 'Ada Lovelace', picture: PICTURE })
      expect((await profiles!.get('ada@openathena.ai'))?.avatar).toBeNull()
    })

    it('is a no-op with no profile store bound', async () => {
      const { g } = seedGate({ profiles: null })
      expect(await g.seedProfileFromClaims('ada@openathena.ai', { name: 'Ada Lovelace', picture: PICTURE })).toBeNull()
    })
  })

  describe('wired into the sign-in handlers', () => {
    /** `seedProfile` undefined = the adapter's default. */
    const seedOpts = (g: ReturnType<typeof createGate>, fetch: typeof globalThis.fetch, seedProfile?: boolean) => ({
      gate: g,
      clientId: CLIENT_ID,
      clientSecret: 'shh',
      redirectUri: REDIRECT,
      fetch,
      ...(seedProfile === undefined ? {} : { seedProfile }),
    })

    /** Drive a full redirect sign-in against gate `g`, seeding per `seedProfile`. */
    async function redirectSignIn(g: ReturnType<typeof createGate>, claims: Record<string, unknown>, seedProfile?: boolean) {
      const startRes = await oidcStart(seedOpts(g, providerFetch(null), seedProfile))({
        request: new Request('https://app.test/auth/google?next=/reports'),
      })
      const state = new URL(startRes.headers.get('location')!).searchParams.get('state')!
      const cookie = setCookies(startRes)[0]!.split(';')[0]!
      const nonce = cookie.split('=')[1]!
      const token = await idToken({ email_verified: true, nonce, ...claims })
      const res = await oidcCallback(seedOpts(g, providerFetch(token), seedProfile))({
        request: new Request(`https://app.test/auth/google/callback?code=abc&state=${encodeURIComponent(state)}`, {
          headers: { cookie },
        }),
      })
      return { res, sessionCookie: setCookies(res)[0]!.split(';')[0]! }
    }

    it('oidcCallback seeds on sign-in by default, and the seeded subject is live on the next authenticate', async () => {
      const { g, profiles } = seedGate()
      const { res, sessionCookie } = await redirectSignIn(g, { email: 'ada@openathena.ai', name: 'Ada Lovelace', picture: PICTURE })
      expect(res.status).toBe(302)
      expect((await profiles!.get('ada@openathena.ai'))?.avatar).toBe(dataUri)
      const auth = await g.authenticate(new Request('https://app.test/', { headers: { Cookie: sessionCookie } }))
      expect(auth?.kind === 'sso' ? auth.subject : null).toEqual({ name: 'Ada Lovelace', avatar: dataUri })
    })

    it('writes nothing with seedProfile: false', async () => {
      const { g, profiles } = seedGate()
      const { res } = await redirectSignIn(g, { email: 'ada@openathena.ai', name: 'Ada Lovelace', picture: PICTURE }, false)
      expect(res.status).toBe(302)
      expect(await profiles!.get('ada@openathena.ai')).toBeNull()
    })

    it('One Tap seeds on its success path too, by default', async () => {
      const { g, profiles } = seedGate()
      const nonceRes = await googleOneTapNonce({ gate: g })()
      const nonce = ((await nonceRes.json()) as { nonce: string }).nonce
      const credential = await idToken({ email: 'ada@openathena.ai', email_verified: true, nonce, name: 'Ada Lovelace', picture: PICTURE })
      const res = await googleOneTapVerify({ gate: g, clientId: CLIENT_ID, fetch: providerFetch(null) })({
        request: new Request('https://app.test/auth/onetap', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ credential, nonce }),
        }),
      })
      expect(res.status).toBe(200)
      expect((await profiles!.get('ada@openathena.ai'))?.avatar).toBe(dataUri)
    })
  })
})
