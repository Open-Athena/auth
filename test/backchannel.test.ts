import { beforeAll, describe, expect, it, vi } from 'vitest'
import { d1BackchannelStore } from '../src/adapters/d1-backchannel.js'
import { backchannelLogoutReceiver, LOGOUT_EVENT, memoryBackchannelStore, verifyLogoutToken, type LogoutVerifierOptions } from '../src/backchannel/index.js'
import { b64uEncode } from '../src/core/base64.js'
import { hashToken } from '../src/core/tokens.js'
import { generateSigningKey, keySet, type KeySet, type SigningJwk } from '../src/provider/keys.js'
import { testDbRaw } from './d1-shim.js'

const NOW = 1800000000
const ISSUER = 'https://login.example.test'
const CLIENT = 'app-a'
const JWKS = `${ISSUER}/oidc/jwks`
const base = {
  iss: ISSUER, aud: CLIENT, sid: 'session-a', sub: 'opaque-hmac-subject', jti: 'event-a',
  iat: NOW, exp: NOW + 120, events: { [LOGOUT_EVENT]: {} },
}
let key: SigningJwk
let keys: KeySet
let other: KeySet
beforeAll(async () => {
  key = await generateSigningKey('test')
  keys = keySet([key])
  other = keySet([await generateSigningKey('test')])
})
const options = (): LogoutVerifierOptions => ({
  issuer: ISSUER, clientId: CLIENT, jwksUrl: JWKS,
  fetch: vi.fn(async () => new Response(JSON.stringify(keys.jwks))),
})
const token = (claims: Record<string, unknown> = base, typ = 'logout+jwt') => keys.sign(claims, typ)
const omit = (field: string) => Object.fromEntries(Object.entries(base).filter(([k]) => k !== field))
const request = (body: string, headers: Record<string, string> = {}) => new Request('https://app.test/auth/backchannel', {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body,
})
const form = (jwt: string) => new URLSearchParams({ logout_token: jwt }).toString()

describe('SID-required signed logout verifier', () => {
  it('returns exact verified evidence using only pinned JWKS', async () => {
    const jwt = await token()
    const opts = options()
    expect(await verifyLogoutToken(jwt, opts, NOW)).toEqual({
      issuer: ISSUER, clientId: CLIENT, sid: base.sid, sub: base.sub, jti: base.jti,
      digest: await hashToken(jwt), issuedAt: NOW, expiresAt: NOW + 120,
    })
    expect(vi.mocked(opts.fetch!).mock.calls.map(([url, init]) => [url, init?.redirect])).toEqual([[JWKS, 'error']])
  })

  it('allows audience arrays, absent subject and future iat exactly at the skew boundary', async () => {
    const jwt = await token({ ...omit('sub'), aud: ['other-app', CLIENT], iat: NOW + 30, exp: NOW + 150 })
    expect(await verifyLogoutToken(jwt, options(), NOW)).toEqual({
      issuer: ISSUER, clientId: CLIENT, sid: base.sid, sub: null, jti: base.jti,
      digest: await hashToken(jwt), issuedAt: NOW + 30, expiresAt: NOW + 150,
    })
  })

  it.each([
    ['wrong issuer', { ...base, iss: 'https://evil.test' }],
    ['wrong audience', { ...base, aud: 'app-b' }],
    ['malformed audience', { ...base, aud: [CLIENT, 7] }],
    ['empty audience', { ...base, aud: [] }],
    ['missing SID (sub is not a session)', omit('sid')],
    ['empty SID', { ...base, sid: '' }],
    ['numeric SID', { ...base, sid: 123 }],
    ['empty subject', { ...base, sub: '' }],
    ['null subject', { ...base, sub: null }],
    ['missing JTI', omit('jti')],
    ['empty JTI', { ...base, jti: '' }],
    ['missing issued time', omit('iat')],
    ['fractional issued time', { ...base, iat: NOW + 0.5 }],
    ['negative issued time', { ...base, iat: -1 }],
    ['future issued time', { ...base, iat: NOW + 31, exp: NOW + 120 }],
    ['missing expiry', omit('exp')],
    ['expired at boundary', { ...base, iat: NOW - 120, exp: NOW }],
    ['expiry before issued time', { ...base, iat: NOW + 2, exp: NOW + 1 }],
    ['excess lifetime', { ...base, exp: NOW + 121 }],
    ['nonfinite expiry', { ...base, exp: Number.POSITIVE_INFINITY }],
    ['missing events', omit('events')],
    ['null events', { ...base, events: null }],
    ['array events', { ...base, events: [] }],
    ['wrong event', { ...base, events: { logout: {} } }],
    ['null event object', { ...base, events: { [LOGOUT_EVENT]: null } }],
    ['array event object', { ...base, events: { [LOGOUT_EVENT]: [] } }],
    ['nonce present even as null', { ...base, nonce: null }],
  ])('rejects %s', async (_name, claims) => {
    expect(await verifyLogoutToken(await token(claims), options(), NOW)).toBeNull()
  })

  it.each(['JWT', 'at+jwt', ''])('rejects token type %s', async typ => {
    expect(await verifyLogoutToken(await token(base, typ), options(), NOW)).toBeNull()
  })

  it('rejects forged signatures, unknown keys, malformed JSON shapes and unsigned tokens', async () => {
    const jwt = await token()
    const [h, p, s] = jwt.split('.') as [string, string, string]
    const malformed = [
      'garbage', `${h}.${p}.`, `${h}.${p}.${s[0] === 'A' ? 'B' : 'A'}${s.slice(1)}`,
      `${b64uEncode(new TextEncoder().encode('null'))}.${p}.${s}`,
      await token(null as unknown as Record<string, unknown>),
      await other.sign(base, 'logout+jwt'),
    ]
    const rotated = keySet([await generateSigningKey('unknown')])
    malformed.push(await rotated.sign(base, 'logout+jwt'))
    expect(await Promise.all(malformed.map(t => verifyLogoutToken(t, options(), NOW)))).toEqual(malformed.map(() => null))
  })

  it('rejects unsupported critical/key headers before fetching and never follows token URLs', async () => {
    const jwt = await token()
    const [, p, s] = jwt.split('.') as [string, string, string]
    const opts = options()
    for (const extra of [{ crit: ['custom'] }, { jku: 'https://evil.test/jwks' }, { jwk: keys.jwks.keys[0] }, { alg: 'none' }, { b64: false }]) {
      const h = b64uEncode(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', typ: 'logout+jwt', kid: 'test', ...extra })))
      expect(await verifyLogoutToken(`${h}.${p}.${s}`, opts, NOW)).toBeNull()
    }
    expect(vi.mocked(opts.fetch!).mock.calls).toEqual([])
  })

  it('accepts a rotated signing key only when the pinned JWKS publishes it', async () => {
    const rotated = keySet([await generateSigningKey('rotated')])
    const jwt = await rotated.sign(base, 'logout+jwt')
    const opts = { ...options(), fetch: async () => new Response(JSON.stringify({ keys: [...keys.jwks.keys, ...rotated.jwks.keys] })) }
    expect(await verifyLogoutToken(jwt, opts, NOW)).toEqual({
      issuer: ISSUER, clientId: CLIENT, sid: base.sid, sub: base.sub, jti: base.jti,
      digest: await hashToken(jwt), issuedAt: NOW, expiresAt: NOW + 120,
    })
  })

  it('rejects signed JSON numeric overflow', async () => {
    const enc = new TextEncoder()
    const h = b64uEncode(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'logout+jwt', kid: 'test' })))
    const p = b64uEncode(enc.encode(JSON.stringify(base).replace(`"exp":${NOW + 120}`, '"exp":1e999')))
    const { kid: _kid, key_ops: _ops, ...jwk } = key
    const signer = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
    const s = b64uEncode(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', signer, enc.encode(`${h}.${p}`)))
    expect(await verifyLogoutToken(`${h}.${p}.${s}`, options(), NOW)).toBeNull()
  })

  it('does not treat unavailable or malformed JWKS as successful verification', async () => {
    const jwt = await token()
    for (const response of [new Response('', { status: 503 }), new Response('{'), new Response('{"keys":null}'), new Response('x'.repeat(65537))]) {
      await expect(verifyLogoutToken(jwt, { ...options(), fetch: async () => response }, NOW)).rejects.toThrow(/^logout JWKS unavailable$/)
    }
  })

  it('rejects invalid configuration, clocks and oversized tokens', async () => {
    const jwt = await token()
    await expect(verifyLogoutToken(jwt, { ...options(), jwksUrl: 'http://localhost/jwks' }, NOW)).rejects.toThrow(/^HTTPS issuer\/JWKS required$/)
    await expect(verifyLogoutToken(jwt, options(), Number.NaN)).rejects.toThrow(/^invalid verification time$/)
    expect(await verifyLogoutToken('x'.repeat(8193), options(), NOW)).toBeNull()
  })
})

describe('optional Request receiver', () => {
  it('persists a signed POST into the SQLite-backed D1 receipt and tombstone tables', async () => {
    const { db, raw } = testDbRaw(['backchannel'])
    const store = d1BackchannelStore(db)
    const handler = backchannelLogoutReceiver({ ...options(), store, retentionS: 3600, now: () => NOW })
    const jwt = await token()
    expect((await handler(request(form(jwt)))).status).toBe(200)
    expect(raw.prepare('SELECT * FROM backchannel_receipts').all().map(r => ({ ...r }))).toEqual([{
      issuer: ISSUER, client_id: CLIENT, jti: base.jti, digest: await hashToken(jwt),
      sid: base.sid, sub: base.sub, accepted_at: NOW, expires_at: NOW + 120, retain_until: NOW + 3600,
    }])
    expect(await store.isRevoked({ issuer: ISSUER, clientId: CLIENT, sid: base.sid }, NOW)).toBe(true)
  })

  it('records an unknown SID without browser credentials and handles identical replay', async () => {
    const store = memoryBackchannelStore()
    const handler = backchannelLogoutReceiver({ ...options(), store, retentionS: 3600, now: () => NOW })
    const jwt = await token()
    const responses = [await handler(request(form(jwt))), await handler(request(`${form(jwt)}&ignored=ok`))]
    expect(await Promise.all(responses.map(async r => [r.status, await r.text(), r.headers.get('set-cookie'), r.headers.get('cache-control')]))).toEqual([
      [200, '', null, 'no-store'], [200, '', null, 'no-store'],
    ])
    expect(await store.isRevoked({ issuer: ISSUER, clientId: CLIENT, sid: base.sid }, NOW)).toBe(true)
    expect(await store.isRevoked({ issuer: ISSUER, clientId: 'app-b', sid: base.sid }, NOW)).toBe(false)
  })

  it('rejects replay conflicts without revoking the substituted target', async () => {
    const store = memoryBackchannelStore()
    const handler = backchannelLogoutReceiver({ ...options(), store, retentionS: 3600, now: () => NOW })
    expect((await handler(request(form(await token())))).status).toBe(200)
    const response = await handler(request(form(await token({ ...base, sid: 'substituted' }))))
    expect([response.status, await response.json()]).toEqual([400, { error: 'invalid_request' }])
    expect(await store.isRevoked({ issuer: ISSUER, clientId: CLIENT, sid: 'substituted' }, NOW)).toBe(false)
  })

  it('never mutates on invalid tokens, duplicate parameters, wrong method/content type or oversized streams', async () => {
    const store = memoryBackchannelStore()
    const accept = vi.spyOn(store, 'accept')
    const handler = backchannelLogoutReceiver({ ...options(), store, retentionS: 3600, now: () => NOW })
    const jwt = await token()
    const requests = [
      new Request('https://app.test/auth/backchannel'),
      request(form(jwt), { 'content-type': 'application/json' }),
      request(''), request('logout_token=bad'), request(`${form(jwt)}&logout_token=bad`),
      request(`${form(jwt)}&extra=1&extra=2`), request(`logout_token=${'x'.repeat(17000)}`),
      request(form(await token(omit('sid')))),
    ]
    const outcomes = []
    for (const req of requests) {
      const r = await handler(req)
      outcomes.push([r.status, await r.json()])
    }
    expect(outcomes).toEqual([405, 400, 400, 400, 400, 400, 413, 400].map(s => [s, { error: 'invalid_request' }]))
    expect(accept.mock.calls).toEqual([])
    expect(await store.isRevoked({ issuer: ISSUER, clientId: CLIENT, sid: base.sid }, NOW)).toBe(false)
  })

  it('propagates storage and dependency faults instead of acknowledging', async () => {
    const store = memoryBackchannelStore()
    vi.spyOn(store, 'accept').mockRejectedValue(new Error('storage unavailable'))
    const handler = backchannelLogoutReceiver({ ...options(), store, retentionS: 3600, now: () => NOW })
    await expect(handler(request(form(await token())))).rejects.toThrow(/^storage unavailable$/)
    const unavailable = backchannelLogoutReceiver({
      ...options(), fetch: async () => new Response('', { status: 503 }),
      store: memoryBackchannelStore(), retentionS: 3600, now: () => NOW,
    })
    await expect(unavailable(request(form(await token())))).rejects.toThrow(/^logout JWKS unavailable$/)
  })

  it('requires a retention contract that covers the verification window', () => {
    expect(() => backchannelLogoutReceiver({ ...options(), store: memoryBackchannelStore(), retentionS: 149 })).toThrow(/^retention must cover token lifetime and clock skew$/)
  })

  it('rejects an expired replay even after receipt cleanup without touching the retained tombstone', async () => {
    const store = memoryBackchannelStore()
    let now = NOW
    const handler = backchannelLogoutReceiver({ ...options(), store, retentionS: 3600, now: () => now })
    const jwt = await token()
    expect((await handler(request(form(jwt)))).status).toBe(200)
    now += 120
    expect(await store.cleanup(now)).toBe(1)
    const accept = vi.spyOn(store, 'accept')
    expect((await handler(request(form(jwt)))).status).toBe(400)
    expect(accept.mock.calls).toEqual([])
    expect(await store.isRevoked({ issuer: ISSUER, clientId: CLIENT, sid: base.sid }, now)).toBe(true)
  })
})
