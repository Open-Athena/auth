/**
 * `verifyAccessJwt` is the whole trust boundary for SSO: whatever it returns
 * becomes an authenticated email. These tests sign real RS256 JWTs with a
 * generated key and serve a matching JWK set, so the checks are exercised
 * against genuine cryptography rather than a stubbed verifier.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { b64uEncode } from '../src/core/base64.js'
import { ssoHandler, verifyAccessJwt } from '../src/adapters/cf-access.js'
import { createGate } from '../src/core/gate.js'
import { domainPolicy } from '../src/core/policy.js'
import { memoryStore } from './memory-store.js'

const TEAM = 'https://acme.cloudflareaccess.com'
const AUD = 'aud-tag-123'
const NOW = Date.parse('2026-08-16T00:00:00Z')
const KID = 'test-kid-1'

const enc = new TextEncoder()
const realFetch = globalThis.fetch

let keys: CryptoKeyPair
let otherKeys: CryptoKeyPair
let jwks: { keys: (JsonWebKey & { kid: string })[] }

const RSA = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }

beforeAll(async () => {
  keys = (await crypto.subtle.generateKey(RSA, true, ['sign', 'verify'])) as CryptoKeyPair
  otherKeys = (await crypto.subtle.generateKey(RSA, true, ['sign', 'verify'])) as CryptoKeyPair
  const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey)
  jwks = { keys: [{ ...jwk, kid: KID }] }
})

afterEach(() => {
  globalThis.fetch = realFetch
})

/** Serve the team's JWK set; record how many times it was asked for. */
function stubCerts(body: unknown = () => jwks): number[] {
  const calls: number[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(1)
    const url = typeof input === 'string' ? input : String(input)
    if (!url.endsWith('/cdn-cgi/access/certs')) return new Response('nope', { status: 404 })
    return new Response(JSON.stringify(typeof body === 'function' ? (body as () => unknown)() : body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  return calls
}

interface Claims {
  iss?: string
  aud?: string | string[]
  exp?: number
  email?: unknown
}

async function makeJwt(claims: Claims, opts: { kid?: string; alg?: string; key?: CryptoKey } = {}): Promise<string> {
  const header = b64uEncode(enc.encode(JSON.stringify({ alg: opts.alg ?? 'RS256', kid: opts.kid ?? KID, typ: 'JWT' })))
  const payload = b64uEncode(enc.encode(JSON.stringify(claims)))
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    opts.key ?? keys.privateKey,
    enc.encode(`${header}.${payload}`),
  )
  return `${header}.${payload}.${b64uEncode(sig)}`
}

const valid = (over: Partial<Claims> = {}): Claims => ({
  iss: TEAM,
  aud: AUD,
  exp: Math.floor(NOW / 1000) + 3600,
  email: 'staff@openathena.ai',
  ...over,
})

describe('verifyAccessJwt', () => {
  it('accepts a well-formed token and returns the email', async () => {
    stubCerts()
    expect(await verifyAccessJwt(await makeJwt(valid()), TEAM, AUD, NOW)).toBe('staff@openathena.ai')
  })

  it('rejects a token signed by a different key', async () => {
    stubCerts()
    const forged = await makeJwt(valid(), { key: otherKeys.privateKey })
    expect(await verifyAccessJwt(forged, TEAM, AUD, NOW)).toBe(null)
  })

  it('rejects a tampered payload under a real signature', async () => {
    stubCerts()
    const jwt = await makeJwt(valid())
    const [h, , s] = jwt.split('.')
    const swapped = b64uEncode(enc.encode(JSON.stringify(valid({ email: 'attacker@evil.test' }))))
    expect(await verifyAccessJwt(`${h}.${swapped}.${s}`, TEAM, AUD, NOW)).toBe(null)
  })

  it('rejects a non-RS256 alg, so a signature can never be reinterpreted', async () => {
    // Alg confusion: `none`, or HS256 keyed with the *public* key, are the
    // classic JWT breaks. Pinning the algorithm before touching the key
    // is what forecloses them.
    stubCerts()
    for (const alg of ['none', 'HS256', 'RS512']) {
      expect(await verifyAccessJwt(await makeJwt(valid(), { alg }), TEAM, AUD, NOW)).toBe(null)
    }
  })

  it('rejects an unknown kid rather than trying every key', async () => {
    stubCerts()
    expect(await verifyAccessJwt(await makeJwt(valid(), { kid: 'not-a-kid' }), TEAM, AUD, NOW)).toBe(null)
  })

  it('rejects an issuer that is not our team', async () => {
    stubCerts()
    const jwt = await makeJwt(valid({ iss: 'https://attacker.cloudflareaccess.com' }))
    expect(await verifyAccessJwt(jwt, TEAM, AUD, NOW)).toBe(null)
  })

  it('rejects an expired token, at the second it expires', async () => {
    stubCerts()
    const exp = Math.floor(NOW / 1000)
    const jwt = await makeJwt(valid({ exp }))
    expect(await verifyAccessJwt(jwt, TEAM, AUD, NOW - 1000)).toBe('staff@openathena.ai')
    expect(await verifyAccessJwt(jwt, TEAM, AUD, NOW)).toBe(null)
  })

  it('rejects a token minted for another app in the same team', async () => {
    // Without the aud check, any Access app in the org would be a valid
    // credential here — which is why `aud` is worth always passing.
    stubCerts()
    const jwt = await makeJwt(valid({ aud: 'some-other-app' }))
    expect(await verifyAccessJwt(jwt, TEAM, AUD, NOW)).toBe(null)
    expect(await verifyAccessJwt(jwt, TEAM, undefined, NOW)).toBe('staff@openathena.ai')
  })

  it('accepts an aud array containing ours', async () => {
    stubCerts()
    const jwt = await makeJwt(valid({ aud: ['other', AUD] }))
    expect(await verifyAccessJwt(jwt, TEAM, AUD, NOW)).toBe('staff@openathena.ai')
  })

  it('rejects a token carrying no usable email', async () => {
    stubCerts()
    const results = await Promise.all(
      [{ email: undefined }, { email: 42 }, { email: null }].map(async over =>
        verifyAccessJwt(await makeJwt(valid(over)), TEAM, AUD, NOW),
      ),
    )
    expect(results).toEqual([null, null, null])
  })

  it('rejects structurally malformed tokens without throwing', async () => {
    stubCerts()
    const results = await Promise.all(
      ['', 'a.b', 'a.b.c.d', 'not-base64!.also-not!.nope!'].map(j => verifyAccessJwt(j, TEAM, AUD, NOW)),
    )
    expect(results).toEqual([null, null, null, null])
  })
})

describe('ssoHandler', () => {
  const gate = () =>
    createGate({
      store: memoryStore(),
      secret: 'test-secret-0123456789abcdef',
      policy: domainPolicy(['openathena.ai'], ['internal']),
    })

  // `ssoHandler` verifies against real `Date.now()` (a request handler has no
  // reason to take an injected clock), so these tokens carry a live expiry.
  const live = (over: Partial<Claims> = {}): Claims =>
    valid({ exp: Math.floor(Date.now() / 1000) + 3600, ...over })

  const call = async (jwt: string | null, url = 'https://x.test/auth/sso') => {
    const headers = jwt ? { 'Cf-Access-Jwt-Assertion': jwt } : {}
    return ssoHandler({ gate: gate(), teamDomain: TEAM, aud: AUD })({ request: new Request(url, { headers }) })
  }

  it('mints a session cookie and bounces to `next`', async () => {
    stubCerts()
    const res = await call(await makeJwt(live()), 'https://x.test/auth/sso?next=%2Ffinances')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/finances')
    expect(res.headers.get('set-cookie')).toMatch(/^oa_auth=[\w-]+\.[\w-]+; HttpOnly; Secure; SameSite=Lax/)
  })

  it('refuses to be an open redirect', async () => {
    stubCerts()
    const targets = ['https://evil.test/x', '//evil.test/x', 'javascript:alert(1)']
    const locations = await Promise.all(
      targets.map(async t => {
        const res = await call(await makeJwt(live()), `https://x.test/auth/sso?next=${encodeURIComponent(t)}`)
        return res.headers.get('location')
      }),
    )
    expect(locations).toEqual(['/', '/', '/'])
  })

  it('401s without a JWT — the signal that the path lost its Access gate', async () => {
    stubCerts()
    const res = await call(null)
    expect(res.status).toBe(401)
    expect(res.headers.get('set-cookie')).toBe(null)
  })

  it('401s on a JWT that fails verification', async () => {
    stubCerts()
    const res = await call(await makeJwt(live(), { key: otherKeys.privateKey }))
    expect([res.status, res.headers.get('set-cookie')]).toEqual([401, null])
  })

  it('403s an authenticated identity the app policy rejects', async () => {
    // Access proved who they are; the app still decides whether they may in.
    stubCerts()
    const res = await call(await makeJwt(live({ email: 'stranger@example.com' })))
    expect([res.status, res.headers.get('set-cookie')]).toEqual([403, null])
  })
})
