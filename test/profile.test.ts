/** Self-serve profiles: name + avatar for a signed-in principal (spec §1–§7). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assetId } from '../src/core/assets.js'
import { bytesToDataUri } from '../src/core/avatar.js'
import { createGate } from '../src/core/gate.js'
import { anyEmailPolicy } from '../src/core/policy.js'
import { authRoutes } from '../src/core/routes.js'
import {
  type MemoryAssetStore,
  type MemoryProfileStore,
  memoryAssetStore,
  memoryGrantStore as memoryStore,
  memoryProfileStore,
} from '../src/testing/index.js'

const SECRET = 'test-secret-0123456789abcdef'
const NOW = Date.parse('2026-09-19T00:00:00Z')
const EMAIL = 'staff@example.com'

/** A real 1×1 PNG, so the upload path exercises the real sniffer. */
const PNG_1x1 = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='),
  c => c.charCodeAt(0),
)
const PNG_DATA_URI = bytesToDataUri('image/png', PNG_1x1)

/** A fetch that serves one image URL and records every URL it is asked for. */
function imageFetch(url: string) {
  const calls: string[] = []
  const fn = (async (input: RequestInfo | URL) => {
    const u = String(input)
    calls.push(u)
    if (u !== url) return new Response(null, { status: 404 })
    return new Response(PNG_1x1, { status: 200, headers: { 'content-type': 'image/png' } })
  }) as typeof globalThis.fetch
  return { fn, calls }
}

const req = (path = '/dash') => new Request(`https://x.test${path}`)
const withCookie = (cookie: string) => new Request('https://x.test/dash', { headers: { Cookie: cookie } })
const pair = (setCookie: string) => setCookie.split(';')[0]!

// Signing and verification share one frozen instant, so the default 30-day
// session TTL can't expire a cookie on a calendar date (see routes.test.ts).
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})
afterEach(() => {
  vi.useRealTimers()
})

describe('putProfile / getProfile', () => {
  it('sets a name the caller reads back, and attaches it as the SSO subject', async () => {
    const profiles = memoryProfileStore()
    const gate = createGate({ store: memoryStore(), profiles, secret: SECRET, policy: anyEmailPolicy(['internal']) })
    const { auth, cookie } = (await gate.signIn(EMAIL, req()))!

    const res = await gate.putProfile(auth, { name: 'Staff Member' })
    expect(res).toEqual({
      ok: true,
      profile: { email: EMAIL, name: 'Staff Member', avatar: null, avatarSrc: null, updatedAt: NOW / 1000 },
    })
    expect(await gate.getProfile(auth)).toEqual(res.ok && res.profile)

    // A later request carries the self-set identity, no render-side change.
    const reauth = await gate.authenticate(withCookie(pair(cookie)))
    expect(reauth).toEqual({
      kind: 'sso',
      email: EMAIL,
      admin: false,
      scopes: ['internal'],
      subject: { name: 'Staff Member' },
    })
  })

  it('copies a { url } avatar to a data: URI and never dereferences the host on read', async () => {
    const url = 'https://img.example/me.png'
    const stub = imageFetch(url)
    const profiles = memoryProfileStore()
    const gate = createGate({
      store: memoryStore(),
      profiles,
      secret: SECRET,
      policy: anyEmailPolicy(['internal']),
      fetch: stub.fn,
    })
    const { auth, cookie } = (await gate.signIn(EMAIL, req()))!

    const res = await gate.putProfile(auth, { avatar: { url } })
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('putProfile should have succeeded')
    // The whole safety property: what's stored is the inlined bytes, not the URL.
    expect(res.profile.avatar).toBe(PNG_DATA_URI)
    expect(res.profile.avatarSrc).toBe('url')
    expect(res.profile.avatar?.includes('img.example')).toBe(false)

    // Reading the profile — and re-resolving the subject on a later request —
    // must not fetch the host again. Exactly one fetch happened, at write time.
    await gate.getProfile(auth)
    const reauth = await gate.authenticate(withCookie(pair(cookie)))
    expect(reauth).toEqual({
      kind: 'sso',
      email: EMAIL,
      admin: false,
      scopes: ['internal'],
      subject: { avatar: PNG_DATA_URI },
    })
    expect(stub.calls).toEqual([url])
  })

  it('inlines an upload as a data: URI when no asset store is bound', async () => {
    const profiles = memoryProfileStore()
    const gate = createGate({ store: memoryStore(), profiles, secret: SECRET, policy: anyEmailPolicy(['internal']) })
    const { auth } = (await gate.signIn(EMAIL, req()))!

    const res = await gate.putProfile(auth, { avatar: { upload: PNG_1x1 } })
    expect(res.ok && [res.profile.avatar, res.profile.avatarSrc]).toEqual([PNG_DATA_URI, 'upload'])
  })

  it('stores an upload in the asset store and GCs the prior asset on replace', async () => {
    const profiles = memoryProfileStore()
    const assets: MemoryAssetStore = memoryAssetStore()
    const gate = createGate({
      store: memoryStore(),
      profiles,
      assets,
      secret: SECRET,
      policy: anyEmailPolicy(['internal']),
    })
    const { auth } = (await gate.signIn(EMAIL, req()))!

    const first = await gate.putProfile(auth, { avatar: { upload: PNG_1x1 } })
    const firstId = first.ok ? assetId(first.profile.avatar) : null
    expect(firstId).not.toBeNull()
    expect(assets.rows.get(firstId!)).toEqual({ bytes: PNG_1x1, type: 'image/png' })

    const second = await gate.putProfile(auth, { avatar: { upload: PNG_1x1 } })
    const secondId = second.ok ? assetId(second.profile.avatar) : null
    // The old object is gone; only the new one survives.
    expect([...assets.rows.keys()]).toEqual([secondId])
  })

  it('clears the avatar back to nothing', async () => {
    const url = 'https://img.example/me.png'
    const stub = imageFetch(url)
    const profiles = memoryProfileStore()
    const gate = createGate({
      store: memoryStore(),
      profiles,
      secret: SECRET,
      policy: anyEmailPolicy(['internal']),
      fetch: stub.fn,
    })
    const { auth } = (await gate.signIn(EMAIL, req()))!

    await gate.putProfile(auth, { avatar: { url } })
    const cleared = await gate.putProfile(auth, { avatar: null })
    expect(cleared.ok && [cleared.profile.avatar, cleared.profile.avatarSrc]).toEqual([null, null])
  })

  it('rejects a bad avatar url without writing a row', async () => {
    const profiles = memoryProfileStore()
    const gate = createGate({ store: memoryStore(), profiles, secret: SECRET, policy: anyEmailPolicy(['internal']) })
    const { auth } = (await gate.signIn(EMAIL, req()))!

    const res = await gate.putProfile(auth, { avatar: { url: 'http://insecure.example/x.png' } })
    expect(res.ok).toBe(false)
    expect(!res.ok && res.reason).toBe('invalid-avatar')
    expect(profiles.rows.size).toBe(0)
  })
})

describe('policy', () => {
  it('reports unconfigured when no profile store is bound', async () => {
    const gate = createGate({ store: memoryStore(), secret: SECRET, policy: anyEmailPolicy(['internal']) })
    const { auth } = (await gate.signIn(EMAIL, req()))!
    expect(await gate.putProfile(auth, { name: 'x' })).toEqual({ ok: false, reason: 'unconfigured' })
    expect(await gate.getProfile(auth)).toBeNull()
  })

  it('forbids a bare grant session by default, and permits an email-bound one when opted in', async () => {
    const denyGate = createGate({ store: memoryStore(), profiles: memoryProfileStore(), secret: SECRET })
    const denyMint = await denyGate.mint({ scopes: ['reports'], email: 'bound@example.com', createdBy: 'me' })
    const denyRedeem = await denyGate.redeem(denyMint.token, req())
    expect(denyRedeem.ok && (await denyGate.putProfile(denyRedeem.auth, { name: 'x' }))).toEqual({
      ok: false,
      reason: 'forbidden',
    })

    const okStore = memoryProfileStore()
    const okGate = createGate({
      store: memoryStore(),
      profiles: okStore,
      secret: SECRET,
      allowGrantSelfEdit: true,
    })
    const okMint = await okGate.mint({ scopes: ['reports'], email: 'bound@example.com', createdBy: 'me' })
    const okRedeem = await okGate.redeem(okMint.token, req())
    const res = okRedeem.ok && (await okGate.putProfile(okRedeem.auth, { name: 'Bound' }))
    // Keyed by the grant's bound email, not the grant id.
    expect(res && res.ok && res.profile.email).toBe('bound@example.com')
  })

  it('throttles edits within profileMinEditIntervalS, then allows one after', async () => {
    const gate = createGate({
      store: memoryStore(),
      profiles: memoryProfileStore(),
      secret: SECRET,
      policy: anyEmailPolicy(['internal']),
      profileMinEditIntervalS: 60,
    })
    const { auth } = (await gate.signIn(EMAIL, req()))!

    expect((await gate.putProfile(auth, { name: 'One' })).ok).toBe(true)
    expect(await gate.putProfile(auth, { name: 'Two' })).toEqual({ ok: false, reason: 'rate-limited' })

    vi.setSystemTime(NOW + 61_000)
    expect((await gate.putProfile(auth, { name: 'Three' })).ok).toBe(true)
  })
})

describe('routes: /api/auth/profile', () => {
  const build = (profiles?: MemoryProfileStore) => {
    const gate = createGate({
      store: memoryStore(),
      ...(profiles ? { profiles } : {}),
      secret: SECRET,
      policy: anyEmailPolicy(['internal']),
    })
    return { gate, handle: authRoutes(gate) }
  }
  const signedInCookie = async (gate: ReturnType<typeof createGate>) =>
    pair((await gate.signIn(EMAIL, req()))!.cookie)
  const call = async (handle: (r: Request) => Promise<Response | null>, init: RequestInit, cookie?: string) => {
    const headers = new Headers(init.headers)
    if (cookie) headers.set('Cookie', cookie)
    const res = (await handle(new Request('https://x.test/api/auth/profile', { ...init, headers })))!
    return { status: res.status, body: JSON.parse(await res.text()) }
  }

  it('401s an anonymous GET', async () => {
    const { handle } = build(memoryProfileStore())
    expect(await call(handle, { method: 'GET' })).toEqual({ status: 401, body: { error: 'unauthenticated' } })
  })

  it('returns null with no row, then reflects a PUT', async () => {
    const profiles = memoryProfileStore()
    const { gate, handle } = build(profiles)
    const cookie = await signedInCookie(gate)

    expect(await call(handle, { method: 'GET' }, cookie)).toEqual({ status: 200, body: null })

    const put = await call(
      handle,
      { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Staff' }) },
      cookie,
    )
    expect(put).toEqual({ status: 200, body: { name: 'Staff', avatar: null } })
    expect(await call(handle, { method: 'GET' }, cookie)).toEqual({
      status: 200,
      body: { name: 'Staff', avatar: null },
    })
  })

  it('501s a PUT when no profile store is configured', async () => {
    const { gate, handle } = build()
    const cookie = await signedInCookie(gate)
    const res = await call(
      handle,
      { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x' }) },
      cookie,
    )
    expect(res).toEqual({ status: 501, body: { error: 'unconfigured' } })
  })
})
