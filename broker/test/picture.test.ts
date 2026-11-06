/**
 * The broker's `picture` over the same stores `src/index.ts` binds (SQLite behind
 * the D1 shim): rows as D1 holds them, including ones written before the claim
 * existed, and the backfill the README gives for those.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { d1ProviderStore } from '../../src/adapters/d1-provider.js'
import { d1AuditSink, d1GrantStore, d1ProfileStore } from '../../src/adapters/d1.js'
import { createGate, domainPolicy } from '../../src/index.js'
import { b64uEncode } from '../../src/core/base64.js'
import { generateSigningKey, hashClientSecret, oidcProviderRoutes, type SigningJwk } from '../../src/provider/index.js'
import { testDbRaw } from '../../test/d1-shim.js'

const ORIGIN = 'https://login.test'
const EMAIL = 'ada@openathena.ai'
const CB = 'https://jobs.oa.dev/auth/oa/callback'
const GOOGLE_PICTURE = 'https://lh3.googleusercontent.com/a/face=s96-c'
const PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='),
  c => c.charCodeAt(0),
)
const DATA_URI = `data:image/png;base64,${btoa(String.fromCharCode(...PNG))}`
/** What `broker/README.md` gives for the broker's rows from before `seed-pending`. */
const BACKFILL = `UPDATE profiles SET avatar_src = 'seed-pending' WHERE avatar IS NULL AND avatar_src IS NULL`

let KEY: SigningJwk
beforeAll(async () => {
  KEY = await generateSigningKey('k1')
})

async function setup() {
  const { db, raw } = testDbRaw(['provider'])
  const profiles = d1ProfileStore(db)
  const gate = createGate({
    store: d1GrantStore(db),
    audit: d1AuditSink(db),
    profiles,
    secret: 'test-secret',
    policy: domainPolicy(['openathena.ai'], ['member']),
    fetch: (async () => new Response(PNG, { headers: { 'content-type': 'image/png' } })) as typeof fetch,
  })
  const provider = oidcProviderRoutes({
    gate,
    issuer: ORIGIN,
    clients: [{ id: 'jobs', secretHash: await hashClientSecret('jobs-secret'), redirectUris: [CB] }],
    keys: [KEY],
    store: d1ProviderStore(db),
    subjectSecret: 's',
    loginUrl: '/signin',
  })
  /** The ID token's claims for an app signing `EMAIL` in. */
  const idToken = async (): Promise<Record<string, unknown>> => {
    const cookie = (await gate.signIn(EMAIL, new Request(ORIGIN)))!.cookies.map(c => c.split(';')[0]).join('; ')
    const verifier = 'v'.repeat(43)
    const challenge = b64uEncode(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
    const q = new URLSearchParams({ client_id: 'jobs', redirect_uri: CB, response_type: 'code', scope: 'openid email profile', code_challenge: challenge, code_challenge_method: 'S256' })
    const auth = (await provider(new Request(`${ORIGIN}/oidc/authorize?${q}`, { headers: { cookie } })))!
    const code = new URL(auth.headers.get('location')!).searchParams.get('code')!
    const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: CB, client_id: 'jobs', client_secret: 'jobs-secret', code_verifier: verifier })
    const res = await provider(new Request(`${ORIGIN}/oidc/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() }))
    const { id_token } = (await res!.json()) as { id_token: string }
    return JSON.parse(atob(id_token.split('.')[1]!.replaceAll('-', '+').replaceAll('_', '/'))) as Record<string, unknown>
  }
  const insert = (avatar: string | null, src: string | null) =>
    raw.prepare(`INSERT INTO profiles (email, name, avatar, avatar_src, updated_at) VALUES (?, 'Ada Lovelace', ?, ?, 1)`).run(EMAIL, avatar, src)
  const row = () => raw.prepare(`SELECT email, name, avatar, avatar_src, updated_at FROM profiles WHERE email = ?`).get(EMAIL)
  return { raw, gate, provider, idToken, insert, row }
}

describe('picture over D1 rows', () => {
  it('a row from before the claim serves its photo, with nothing else done to it', async () => {
    const { provider, idToken, insert, row } = await setup()
    insert(DATA_URI, 'url')
    const before = row()
    const claims = await idToken()
    expect(claims.picture).toMatch(/^https:\/\/login\.test\/oidc\/picture\/[A-Za-z0-9_-]+$/)
    const res = await provider(new Request(claims.picture as string))
    expect([res!.status, res!.headers.get('content-type'), new Uint8Array(await res!.arrayBuffer())]).toEqual([200, 'image/png', PNG])
    expect(row()).toEqual(before)
  })

  it('a first Google sign-in stores a copy and serves that, never the Google URL', async () => {
    const { gate, provider, idToken } = await setup()
    await gate.seedProfileFromClaims(EMAIL, { name: 'Ada Lovelace', picture: GOOGLE_PICTURE })
    const claims = await idToken()
    expect(claims.picture).toMatch(/^https:\/\/login\.test\/oidc\/picture\/[A-Za-z0-9_-]+$/)
    const res = await provider(new Request(claims.picture as string))
    expect(new Uint8Array(await res!.arrayBuffer())).toEqual(PNG)
  })

  it('a name-only row stays that way until the backfill, then fills at the next Google sign-in', async () => {
    const { raw, gate, idToken, insert, row } = await setup()
    insert(null, null)
    await gate.seedProfileFromClaims(EMAIL, { name: 'Google Name', picture: GOOGLE_PICTURE })
    expect((await idToken()).picture).toBeUndefined()

    raw.exec(BACKFILL)
    await gate.seedProfileFromClaims(EMAIL, { name: 'Google Name', picture: GOOGLE_PICTURE })
    expect(row()).toEqual({ email: EMAIL, name: 'Ada Lovelace', avatar: DATA_URI, avatar_src: 'url', updated_at: 1 })
    expect((await idToken()).picture).toMatch(/^https:\/\/login\.test\/oidc\/picture\//)
  })

  it('the backfill leaves rows with a photo alone', async () => {
    const { raw, insert, row } = await setup()
    insert(DATA_URI, 'upload')
    const before = row()
    raw.exec(BACKFILL)
    expect(row()).toEqual(before)
  })
})
