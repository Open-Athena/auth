import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { d1Allowlist, d1GrantStore } from '../src/adapters/d1.js'
import { createGate } from '../src/core/gate.js'
import { adminPolicy, allowlistPolicy, firstMatch } from '../src/core/policy.js'
import { authRoutes } from '../src/core/routes.js'
import type { AllowEntry, AllowlistStore } from '../src/core/store.js'
import { testDb } from './d1-shim.js'

const entry = (email: string, scopes: string[], source = 'manual'): AllowEntry => ({
  email,
  scopes,
  source,
  note: null,
  addedBy: 'boss@openathena.ai',
  updatedAt: 1000,
})

const emailsSources = (rows: AllowEntry[]) => rows.map(r => `${r.email}:${r.source}`)

describe('d1Allowlist store', () => {
  let store: AllowlistStore
  beforeEach(() => {
    store = d1Allowlist(testDb())
  })

  it('looks up null for an unlisted email and the row scopes for a listed one', async () => {
    await store.put(entry('a@x.test', ['view']))
    expect(await store.lookup('a@x.test')).toEqual(['view'])
    expect(await store.lookup('missing@x.test')).toBeNull()
  })

  it('folds case on both write and lookup', async () => {
    await store.put(entry('MixedCase@X.test', ['view']))
    expect(await store.lookup('mixedcase@x.test')).toEqual(['view'])
    expect((await store.list()).map(r => r.email)).toEqual(['mixedcase@x.test'])
  })

  it('upserts by email rather than duplicating', async () => {
    await store.put(entry('a@x.test', ['view']))
    await store.put(entry('a@x.test', ['view', 'admin']))
    expect(await store.lookup('a@x.test')).toEqual(['view', 'admin'])
    expect((await store.list()).length).toBe(1)
  })

  it('lists ordered by email', async () => {
    for (const e of ['c@x.test', 'a@x.test', 'b@x.test']) await store.put(entry(e, ['view']))
    expect((await store.list()).map(r => r.email)).toEqual(['a@x.test', 'b@x.test', 'c@x.test'])
  })

  it('reports whether remove deleted a row', async () => {
    await store.put(entry('a@x.test', ['view']))
    expect(await store.remove('a@x.test')).toBe(true)
    expect(await store.remove('a@x.test')).toBe(false)
    expect(await store.lookup('a@x.test')).toBeNull()
  })

  it('replaceSource swaps only its own source, leaving other rows intact', async () => {
    await store.put(entry('hand@x.test', ['view'], 'manual'))
    await store.replaceSource('sync:board@x.test', [entry('old@x.test', ['view'], 'sync:board@x.test')])
    // A second sync run: old@ drops out, new@ comes in, hand@ is never touched.
    await store.replaceSource('sync:board@x.test', [entry('new@x.test', ['view'], 'sync:board@x.test')])
    expect(emailsSources(await store.list())).toEqual(['hand@x.test:manual', 'new@x.test:sync:board@x.test'])
    expect(await store.lookup('old@x.test')).toBeNull()
  })

  it('rejects a replaceSource entry tagged with a different source', async () => {
    await expect(
      store.replaceSource('sync:board@x.test', [entry('x@x.test', ['view'], 'manual')]),
    ).rejects.toThrow('entry x@x.test carries source manual')
  })
})

describe('allowlistPolicy', () => {
  let store: AllowlistStore
  beforeEach(async () => {
    store = d1Allowlist(testDb())
    await store.put(entry('member@x.test', ['view']))
  })

  it('returns the row scopes for a member and null for a stranger', async () => {
    const policy = allowlistPolicy(store)
    expect(await policy('member@x.test')).toEqual(['view'])
    expect(await policy('stranger@x.test')).toBeNull()
  })

  it('lowercases the lookup, so a mixed-case SSO email still matches', async () => {
    expect(await allowlistPolicy(store)('Member@X.test')).toEqual(['view'])
  })

  it('overrides row scopes with a fixed set when given { scopes }, and still denies non-members', async () => {
    const policy = allowlistPolicy(store, { scopes: ['reports'] })
    expect(await policy('member@x.test')).toEqual(['reports'])
    expect(await policy('stranger@x.test')).toBeNull()
  })

  it('composes under firstMatch behind adminPolicy', async () => {
    const policy = firstMatch(adminPolicy(['boss@x.test']), allowlistPolicy(store))
    expect(await policy('boss@x.test')).toEqual(['*'])
    expect(await policy('member@x.test')).toEqual(['view'])
    expect(await policy('stranger@x.test')).toBeNull()
  })
})

describe('/allowed admin routes', () => {
  const SECRET = 'test-secret-0123456789abcdef'
  const NOW = Date.parse('2026-08-16T00:00:00Z')

  let db: D1Database
  let store: AllowlistStore
  let gate: ReturnType<typeof createGate>
  let handle: ReturnType<typeof authRoutes>

  const url = (path: string) => `https://x.test/api/auth${path}`
  const call = async (path: string, init: RequestInit = {}, cookie?: string) => {
    const headers = new Headers(init.headers)
    if (cookie) headers.set('Cookie', cookie)
    if (init.body) headers.set('content-type', 'application/json')
    const res = await handle(new Request(url(path), { ...init, headers }))
    if (!res) throw new Error(`route not handled: ${path}`)
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : null }
  }
  const pair = (setCookie: string) => setCookie.split(';')[0]!
  const signIn = async (email: string) => {
    const res = await gate.signIn(email, new Request('https://x.test/'), NOW)
    return pair(res!.cookie)
  }

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    db = testDb()
    store = d1Allowlist(db)
    await store.put(entry('member@x.test', ['view']))
    gate = createGate({
      store: d1GrantStore(db),
      secret: SECRET,
      adminEmails: ['boss@x.test'],
      policy: allowlistPolicy(store),
    })
    handle = authRoutes(gate, { allowlist: store })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('lists the allowlist for an admin', async () => {
    const res = await call('/allowed', {}, await signIn('boss@x.test'))
    expect(res.status).toBe(200)
    expect(res.body.allowed.map((r: AllowEntry) => r.email)).toEqual(['member@x.test'])
  })

  it('rejects an anonymous caller with 401 and an authenticated non-admin with 403', async () => {
    expect((await call('/allowed')).status).toBe(401)
    const member = await signIn('member@x.test')
    expect((await call('/allowed', {}, member)).status).toBe(403)
  })

  it('501s when no allowlist store is wired', async () => {
    const bare = authRoutes(gate)
    const res = await bare(new Request(url('/allowed'), { headers: { Cookie: await signIn('boss@x.test') } }))
    expect(res?.status).toBe(501)
  })

  it('adds an email as a manual row attributed to the admin', async () => {
    const admin = await signIn('boss@x.test')
    const add = await call('/allowed', { method: 'POST', body: JSON.stringify({ email: 'New@X.test', scopes: ['view'] }) }, admin)
    expect(add.status).toBe(200)
    expect(add.body.entry).toEqual({
      email: 'new@x.test',
      scopes: ['view'],
      source: 'manual',
      note: null,
      addedBy: 'boss@x.test',
      updatedAt: Math.floor(NOW / 1000),
    })
    expect((await store.list()).map(r => r.email)).toEqual(['member@x.test', 'new@x.test'])
  })

  it('rejects a malformed email and a non-array scopes field with 400', async () => {
    const admin = await signIn('boss@x.test')
    expect((await call('/allowed', { method: 'POST', body: JSON.stringify({ email: 'nope', scopes: [] }) }, admin)).status).toBe(400)
    expect(
      (await call('/allowed', { method: 'POST', body: JSON.stringify({ email: 'a@x.test', scopes: 'view' }) }, admin)).status,
    ).toBe(400)
  })

  it('removes an email by its (encoded) address, reporting whether a row was there', async () => {
    const admin = await signIn('boss@x.test')
    const path = `/allowed/${encodeURIComponent('member@x.test')}`
    expect(await call(path, { method: 'DELETE' }, admin)).toEqual({ status: 200, body: { ok: true } })
    expect(await call(path, { method: 'DELETE' }, admin)).toEqual({ status: 200, body: { ok: false } })
    expect(await store.lookup('member@x.test')).toBeNull()
  })
})
