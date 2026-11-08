import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createGate } from '../src/core/gate.js'
import { b64uDecodeString } from '../src/core/base64.js'
import { generateSigningKey, hashClientSecret, memoryProviderStore, oidcProviderRoutes, type SigningJwk } from '../src/provider/index.js'
import { memoryAudit, memoryStore } from './memory-store.js'
import broker from '../broker/src/index.js'
import { testDbRaw } from './d1-shim.js'

vi.mock('@open-athena/auth', () => import('../src/index.js'))
vi.mock('@open-athena/auth/d1', () => import('../src/adapters/d1.js'))
vi.mock('@open-athena/auth/oidc', () => import('../src/adapters/oidc.js'))

const ISSUER = 'https://login.test'
const CALLBACK = 'https://app.test/cb'
const T0 = Date.UTC(2026, 10, 7, 12)
const ERROR = { error: 'login_required', error_description: 'Verified authentication freshness is not supported', state: 's1', iss: ISSUER }
let key: SigningJwk

beforeAll(async () => {
  key = await generateSigningKey('reauth-test')
})
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
})
afterEach(() => {
  vi.useRealTimers()
})

async function setup(age = 90) {
  const gate = createGate({ store: memoryStore(), audit: memoryAudit(), secret: 'test-only-session', policy: async () => ['member'] })
  const session = await gate.signIn('person@example.test', new Request(ISSUER), T0 - age * 1000)
  const cookie = session!.cookies.map(c => c.split(';')[0]).join('; ')
  const store = memoryProviderStore()
  const putCode = vi.spyOn(store, 'putCode')
  const provider = oidcProviderRoutes({
    gate, issuer: ISSUER, loginUrl: '/signin', store, keys: [key], subjectSecret: 'test-only-subject',
    clients: [{ id: 'app', secretHash: await hashClientSecret('test-only-client'), redirectUris: [CALLBACK], requirePkce: false }],
    claims: () => ({ auth_time: T0 / 1000 }),
  })
  const authorize = (params: Record<string, string>, signedIn = true) => provider(new Request(`${ISSUER}/oidc/authorize?${new URLSearchParams({
    client_id: 'app', redirect_uri: CALLBACK, response_type: 'code', scope: 'openid', state: 's1', ...params,
  })}`, { headers: signedIn ? { cookie } : {} }))
  return { provider, authorize, putCode }
}

async function expectRefusal(res: Response | null) {
  const to = new URL(res!.headers.get('location')!)
  expect([res!.status, `${to.origin}${to.pathname}`, Object.fromEntries(to.searchParams)]).toEqual([302, CALLBACK, ERROR])
}

describe('authentication freshness without verified upstream evidence', () => {
  it.each(['0', '', '-1', String(T0 / 1000 - 90), String(T0 / 1000 + 3600)])('a caller-supplied oa_login_after=%j cannot satisfy prompt=login', async marker => {
    const { authorize, putCode } = await setup()
    await expectRefusal(await authorize({ prompt: 'login', oa_login_after: marker }))
    expect(putCode.mock.calls).toEqual([])
  })

  it.each(['0', '1', '10000'])('max_age=%s refuses even a session issued in this second', async maxAge => {
    const { authorize, putCode } = await setup(0)
    await expectRefusal(await authorize({ max_age: maxAge }))
    expect(putCode.mock.calls).toEqual([])
  })

  it.each([true, false])('prompt=login fails in one response with signedIn=%s, never a login loop', async signedIn => {
    const { authorize, putCode } = await setup()
    await expectRefusal(await authorize({ prompt: 'login' }, signedIn))
    expect(putCode.mock.calls).toEqual([])
  })

  it('a silent freshness request returns the same refusal', async () => {
    const { authorize } = await setup()
    await expectRefusal(await authorize({ prompt: 'none', max_age: '1' }))
  })

  it('an ordinary silent sign-in works, without auth_time from local iat, legacy code data or a claims hook', async () => {
    const { authorize, provider, putCode } = await setup()
    const res = await authorize({ prompt: 'none' })
    const to = new URL(res!.headers.get('location')!)
    expect([res!.status, to.origin + to.pathname, [...to.searchParams.keys()].sort()]).toEqual([302, CALLBACK, ['code', 'iss', 'state']])
    const record = putCode.mock.calls[0]![0]
    expect({ ...record, codeHash: '<hash>' }).toEqual({
      codeHash: '<hash>', clientId: 'app', redirectUri: CALLBACK, challenge: '', nonce: null,
      email: 'person@example.test', scope: 'openid', authTime: null, expiresAt: T0 / 1000 + 60,
    })
    await putCode({ ...record, authTime: T0 / 1000 - 90 })
    const token = await provider(new Request(`${ISSUER}/oidc/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: to.searchParams.get('code')!, redirect_uri: CALLBACK, client_id: 'app', client_secret: 'test-only-client' }),
    }))
    expect(token!.status).toBe(200)
    const body = await token!.json() as { id_token: string }
    const claims = JSON.parse(b64uDecodeString(body.id_token.split('.')[1]!))
    expect({ ...claims, sub: '<sub>' }).toEqual({ iss: ISSUER, sub: '<sub>', aud: 'app', iat: T0 / 1000, exp: T0 / 1000 + 300 })
  })

  it('unsupported freshness is not advertised as an available prompt or claim', async () => {
    const { provider } = await setup()
    const res = await provider(new Request(`${ISSUER}/.well-known/openid-configuration`))
    const body = await res!.json() as Record<string, unknown>
    expect([body.prompt_values_supported, body.claims_supported]).toEqual([
      ['none', 'select_account'], ['iss', 'sub', 'aud', 'exp', 'iat', 'nonce', 'email', 'email_verified', 'name', 'picture'],
    ])
  })
})

describe('broker sign-in prompt mapping', () => {
  async function signin(prompt: string, devSignin = false) {
    const { db, raw } = testDbRaw(['provider'])
    const params = new URLSearchParams({ next: '/oidc/authorize?client_id=app', prompt })
    const origin = devSignin ? 'http://localhost:4191' : ISSUER
    try {
      return await broker.fetch(new Request(`${origin}/signin?${params}`), {
        DB: db, WORKSPACE_DOMAIN: 'example.test', CLIENT_REDIRECT_DOMAIN: 'example.test',
        SESSION_SECRET: 'test-only-session', OIDC_SIGNING_KEY: JSON.stringify(key),
        GOOGLE_CLIENT_ID: 'test-only-client', GOOGLE_CLIENT_SECRET: 'test-only-secret',
        ...(devSignin ? { DEV_SIGNIN: '1' } : {}),
      })
    } finally {
      raw.close()
    }
  }

  it.each([false, true])('does not turn prompt=login into a chooser or local sign-in with devSignin=%s', async devSignin => {
    const res = await signin('login', devSignin)
    expect([res.status, res.headers.get('location'), res.headers.get('cache-control'), await res.text()]).toEqual([
      400, null, 'no-store', 'Verified authentication freshness is not supported.\n',
    ])
  })

  it('keeps explicit account selection distinct from ordinary sign-in', async () => {
    const redirects = []
    for (const prompt of ['', 'select_account']) {
      const res = await signin(prompt)
      const to = new URL(res.headers.get('location')!, ISSUER)
      redirects.push({ status: res.status, path: to.pathname, params: Object.fromEntries(to.searchParams) })
    }
    const next = '/signin/return?next=%2Foidc%2Fauthorize%3Fclient_id%3Dapp'
    expect(redirects).toEqual([
      { status: 302, path: '/auth/google/start', params: { next } },
      { status: 302, path: '/auth/google/start', params: { next, account: 'choose' } },
    ])
  })
})
