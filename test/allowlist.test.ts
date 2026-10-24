import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { d1Allowlist, d1GrantStore } from '../src/adapters/d1.js'
import type { GrantStore } from '../src/core/store.js'
import { memoryAudit, memoryGrantStore, memoryProfileStore } from '../src/testing/index.js'
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

  describe('POST /allowed/sync', () => {
    const runs: number[] = []
    const okSync = { run: async () => { runs.push(1); return [{ group: 'board@x.test', source: 'sync:board@x.test', count: 2 }] } }

    beforeEach(() => {
      runs.length = 0
    })

    it('runs the sync for an admin and returns its result', async () => {
      handle = authRoutes(gate, { allowlist: store, sync: okSync })
      const res = await call('/allowed/sync', { method: 'POST' }, await signIn('boss@x.test'))
      expect(res).toEqual({ status: 200, body: { ok: true, result: [{ group: 'board@x.test', source: 'sync:board@x.test', count: 2 }] } })
      expect(runs).toEqual([1])
    })

    it('401s anonymous, 403s a non-admin, 501s an admin when no sync is wired — and never runs', async () => {
      handle = authRoutes(gate, { allowlist: store })
      expect((await call('/allowed/sync', { method: 'POST' })).status).toBe(401)
      expect((await call('/allowed/sync', { method: 'POST' }, await signIn('member@x.test'))).status).toBe(403)
      expect(await call('/allowed/sync', { method: 'POST' }, await signIn('boss@x.test'))).toEqual({
        status: 501,
        body: { error: 'sync not configured' },
      })
      expect(runs).toEqual([])
    })

    it('accepts the bearer token in place of a session, and rejects a wrong or absent one', async () => {
      handle = authRoutes(gate, { allowlist: store, sync: { ...okSync, token: 'cron-secret' } })
      const bearer = (t: string) => call('/allowed/sync', { method: 'POST', headers: { authorization: `Bearer ${t}` } })
      expect((await bearer('cron-secret')).status).toBe(200)
      expect((await bearer('wrong')).status).toBe(401)
      expect((await call('/allowed/sync', { method: 'POST' })).status).toBe(401)
      expect(runs).toEqual([1])
    })

    it('ignores a bearer when no token is configured (a session is still required)', async () => {
      handle = authRoutes(gate, { allowlist: store, sync: okSync })
      const res = await call('/allowed/sync', { method: 'POST', headers: { authorization: 'Bearer anything' } })
      expect(res.status).toBe(401)
      expect(runs).toEqual([])
    })

    it('reports a failing sync as 502 with the error, leaving the table alone', async () => {
      handle = authRoutes(gate, { allowlist: store, sync: { run: async () => { throw new Error('google token endpoint: HTTP 401') } } })
      const res = await call('/allowed/sync', { method: 'POST' }, await signIn('boss@x.test'))
      expect(res).toEqual({ status: 502, body: { ok: false, error: 'google token endpoint: HTTP 401' } })
      expect((await store.list()).map(r => r.email)).toEqual(['member@x.test'])
    })
  })

  describe('POST /grants with `allowlist`', () => {
    const mint = async (body: Record<string, unknown>) =>
      call('/grants', { method: 'POST', body: JSON.stringify({ scopes: ['view'], ...body }) }, await signIn('boss@x.test'))
    const row = async (email: string) => (await store.list()).find(r => r.email === email) ?? null

    it('adds the link email with the link scopes, noting the link', async () => {
      const res = await mint({ name: 'Ada', email: 'Ada@Y.test', allowlist: true })
      expect([res.status, res.body.allowed]).toEqual([200, { email: 'ada@y.test', status: 'added' }])
      expect(await row('ada@y.test')).toEqual({
        email: 'ada@y.test',
        scopes: ['view'],
        source: 'manual',
        note: 'with link "Ada"',
        addedBy: 'boss@x.test',
        updatedAt: NOW / 1000,
      })
    })

    it('leaves a row that already covers the scopes untouched', async () => {
      const res = await mint({ email: 'member@x.test', allowlist: true })
      expect(res.body.allowed).toEqual({ email: 'member@x.test', status: 'already' })
      expect(await row('member@x.test')).toEqual(entry('member@x.test', ['view']))
    })

    it('widens a row missing some of the scopes, taking it over as manual', async () => {
      await store.put(entry('synced@x.test', ['view'], 'sync:board@x.test'))
      const res = await mint({ email: 'synced@x.test', scopes: ['view', 'reports'], allowlist: true })
      expect(res.body.allowed).toEqual({ email: 'synced@x.test', status: 'widened' })
      expect(await row('synced@x.test')).toEqual({
        email: 'synced@x.test',
        scopes: ['view', 'reports'],
        source: 'manual',
        note: 'with a share link',
        addedBy: 'boss@x.test',
        updatedAt: NOW / 1000,
      })
    })

    it('without the flag, mints and leaves the allowlist alone', async () => {
      const res = await mint({ email: 'ada@y.test' })
      expect([res.status, Object.keys(res.body).sort(), await row('ada@y.test')]).toEqual([200, ['grant', 'token'], null])
    })

    it('refuses before minting when there is no valid email, or no allowlist mounted', async () => {
      expect(await mint({ allowlist: true })).toEqual({ status: 400, body: { error: 'allowlist needs a valid email' } })
      handle = authRoutes(gate)
      expect(await mint({ email: 'ada@y.test', allowlist: true })).toEqual({
        status: 501,
        body: { error: 'allowlist not configured' },
      })
      expect(await gate.list()).toEqual([])
    })
  })
})

describe('PATCH /grants/:id binding an email', () => {
  const SECRET = 'test-secret-0123456789abcdef'
  const NOW = Date.parse('2026-08-16T00:00:00Z')
  const url = (path: string) => `https://x.test/api/auth${path}`
  const pair = (setCookie: string) => setCookie.split(';')[0]!

  const stores: [string, (db: D1Database) => GrantStore][] = [
    ['d1', db => d1GrantStore(db)],
    ['memory', () => memoryGrantStore()],
  ]

  describe.each(stores)('%s grant store', (_, makeStore) => {
    let store: AllowlistStore
    let gate: ReturnType<typeof createGate>
    let handle: ReturnType<typeof authRoutes>
    let audit: ReturnType<typeof memoryAudit>

    const call = async (path: string, init: RequestInit = {}, cookie?: string) => {
      const headers = new Headers(init.headers)
      if (cookie) headers.set('Cookie', cookie)
      if (init.body) headers.set('content-type', 'application/json')
      const res = await handle(new Request(url(path), { ...init, headers }))
      if (!res) throw new Error(`route not handled: ${path}`)
      const text = await res.text()
      return { status: res.status, body: text ? JSON.parse(text) : null, setCookie: res.headers.get('set-cookie') }
    }
    const admin = async () => pair((await gate.signIn('boss@x.test', new Request('https://x.test/'), NOW))!.cookie)
    const mint = async (body: Record<string, unknown> = {}) => {
      const res = await call('/grants', { method: 'POST', body: JSON.stringify({ scopes: ['view'], ...body }) }, await admin())
      return { id: res.body.grant.id as string, token: res.body.token as string }
    }
    const patch = async (id: string, body: Record<string, unknown>) =>
      call(`/grants/${id}`, { method: 'PATCH', body: JSON.stringify(body) }, await admin())
    const holderOf = async (token: string) =>
      pair((await call('/exchange', { method: 'POST', body: JSON.stringify({ token }) })).setCookie!)
    const row = async (email: string) => (await store.list()).find(r => r.email === email) ?? null
    const updates = (id: string) => audit.events.filter(e => e.event === 'update' && e.grantId === id).map(e => e.reason)

    beforeEach(async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(NOW)
      const db = testDb()
      store = d1Allowlist(db)
      await store.put(entry('member@x.test', ['view']))
      audit = memoryAudit()
      gate = createGate({
        store: makeStore(db),
        secret: SECRET,
        adminEmails: ['boss@x.test'],
        audit,
        profiles: memoryProfileStore(),
        allowGrantSelfEdit: true,
      })
      handle = authRoutes(gate, { allowlist: store })
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it("binds the holder's existing session in place: same cookie, now email-bound", async () => {
      const { id, token } = await mint({ name: 'Ben' })
      const holder = await holderOf(token)
      const before = await call('/whoami', {}, holder)
      const auth = async () => (await gate.authenticate(new Request(url('/whoami'), { headers: { Cookie: holder } })))!
      expect([before.body.email, (await gate.putProfile(await auth(), { name: 'Ben K' })).ok]).toEqual([null, false])

      const res = await patch(id, { email: '  Ben@Y.test ' })
      expect([res.status, res.body.grant.email, Object.keys(res.body)]).toEqual([200, 'ben@y.test', ['grant']])
      expect((await call('/whoami', {}, holder)).body.email).toBe('ben@y.test')
      // Self-edit now admits the holder: the profile is keyed by the bound address.
      expect((await gate.putProfile(await auth(), { name: 'Ben K' })).ok).toBe(true)
      expect(await row('ben@y.test')).toBeNull()
      expect(updates(id)).toEqual(['email'])
    })

    it('with `allowlist: true`, adds the address with the link scopes, as minting does', async () => {
      const { id } = await mint({ name: 'Ben' })
      const res = await patch(id, { email: 'ben@y.test', allowlist: true })
      expect([res.status, res.body.allowed]).toEqual([200, { email: 'ben@y.test', status: 'added' }])
      expect(await row('ben@y.test')).toEqual({
        email: 'ben@y.test',
        scopes: ['view'],
        source: 'manual',
        note: 'with link "Ben"',
        addedBy: 'boss@x.test',
        updatedAt: NOW / 1000,
      })
      expect(updates(id)).toEqual(['allowlist,email'])
    })

    it('leaves a covering row alone and widens a narrower one, taking it over as manual', async () => {
      const covered = await mint()
      expect((await patch(covered.id, { email: 'member@x.test', allowlist: true })).body.allowed).toEqual({
        email: 'member@x.test',
        status: 'already',
      })
      expect(await row('member@x.test')).toEqual(entry('member@x.test', ['view']))

      await store.put(entry('synced@x.test', ['view'], 'sync:board@x.test'))
      const wider = await mint({ scopes: ['view', 'reports'] })
      expect((await patch(wider.id, { email: 'synced@x.test', allowlist: true })).body.allowed).toEqual({
        email: 'synced@x.test',
        status: 'widened',
      })
      expect(await row('synced@x.test')).toEqual({
        email: 'synced@x.test',
        scopes: ['view', 'reports'],
        source: 'manual',
        note: 'with a share link',
        addedBy: 'boss@x.test',
        updatedAt: NOW / 1000,
      })
    })

    it('refuses, changing nothing: a bad email, `allowlist` without one, no allowlist store, a revoked link', async () => {
      const { id } = await mint()
      expect(await patch(id, { email: 'not-an-email' })).toMatchObject({ status: 400, body: { error: 'invalid email' } })
      expect(await patch(id, { allowlist: true })).toMatchObject({
        status: 400,
        body: { error: 'allowlist needs a valid email' },
      })
      expect(await patch(id, { email: null, allowlist: true })).toMatchObject({
        status: 400,
        body: { error: 'allowlist needs a valid email' },
      })
      handle = authRoutes(gate)
      expect(await patch(id, { email: 'ben@y.test', allowlist: true })).toMatchObject({
        status: 501,
        body: { error: 'allowlist not configured' },
      })
      handle = authRoutes(gate, { allowlist: store })
      await gate.revoke(id)
      expect(await patch(id, { email: 'ben@y.test' })).toMatchObject({ status: 409, body: { error: 'link is revoked' } })
      expect([(await gate.byId(id))!.email, await row('ben@y.test'), updates(id)]).toEqual([null, null, []])
    })

    it('refuses a non-owner when admins are scoped to their own links', async () => {
      const { id } = await mint()
      handle = authRoutes(gate, { allowlist: store, scopeToCreator: () => 'someone-else' })
      expect(await patch(id, { email: 'ben@y.test' })).toMatchObject({ status: 404, body: { error: 'not found' } })
      expect((await gate.byId(id))!.email).toBeNull()
    })

    it('clearing un-binds the session on its next request and leaves the allowlist row', async () => {
      const { id, token } = await mint()
      const holder = await holderOf(token)
      await patch(id, { email: 'ben@y.test', allowlist: true })
      const cleared = await patch(id, { email: null })
      expect([cleared.status, cleared.body.grant.email]).toEqual([200, null])
      expect((await call('/whoami', {}, holder)).body.email).toBeNull()
      expect((await row('ben@y.test'))?.scopes).toEqual(['view'])
      // Blank clears too.
      await patch(id, { email: 'ben@y.test' })
      expect((await patch(id, { email: '  ' })).body.grant.email).toBeNull()
    })

    it('a rebind records the address it replaced', async () => {
      const { id } = await mint({ email: 'old@y.test' })
      await patch(id, { email: 'new@y.test' })
      await patch(id, { email: 'new@y.test' })
      await patch(id, { email: null })
      expect(updates(id)).toEqual(['email; was old@y.test', 'email', 'email'])
    })
  })
})
