import { describe, expect, it, vi } from 'vitest'
import { AuthClientError, createAuthClient, shareUrl } from '../src/client/api.js'
import { createGate } from '../src/core/gate.js'
import { authRoutes } from '../src/core/routes.js'
import type { RouteOptions } from '../src/core/routes.js'
import type { AuditQuery } from '../src/core/store.js'
import { memoryGrantStore } from '../src/testing/index.js'

async function httpError(result: Promise<unknown>): Promise<{ name: string; status: number; body: unknown }> {
  try {
    await result
  } catch (error) {
    if (!(error instanceof AuthClientError)) throw error
    return { name: error.name, status: error.status, body: error.body }
  }
  throw new Error('Expected an AuthClientError rejection')
}

async function fixture(options: RouteOptions = {}, email: string | null = 'admin@example.com') {
  const store = memoryGrantStore()
  const gate = createGate({ store, secret: 'client-test-secret-0123456789', adminEmails: ['admin@example.com'] })
  const signed = email ? await gate.signIn(email, new Request('https://app.test/')) : null
  const handle = authRoutes(gate, options)
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const headers = new Headers(init?.headers)
    if (signed) headers.set('cookie', signed.cookie.split(';')[0]!)
    const response = await handle(new Request(new URL(String(input), 'https://app.test'), { ...init, headers }))
    if (!response) throw new Error('Route was not mounted')
    return response
  }
  return { store, gate, client: createAuthClient({ basePath: options.basePath, fetch }) }
}

describe('typed auth client', () => {
  it('runs the grant lifecycle against real routes and the memory store', async () => {
    const { client, store } = await fixture({ basePath: '/custom/auth' })
    expect(await client.whoami()).toEqual({
      kind: 'sso', email: 'admin@example.com', admin: true, scopes: ['*'], subject: null,
    })
    const minted = await client.grants.mint({ name: 'Board', scopes: ['read'], avatar: null })
    const { id } = minted.grant
    expect(minted).toEqual({ grant: await store.byId(id), token: minted.token })
    expect(typeof minted.token).toBe('string')
    expect(minted.token.length > 0).toBe(true)
    expect(await client.grants.list()).toEqual({ grants: [minted.grant] })
    const updated = await client.grants.update(id, { name: 'Updated', note: 'For board' })
    expect(updated).toEqual({ grant: { ...minted.grant, name: 'Updated', note: 'For board' } })
    expect(await client.grants.disable(id)).toEqual({ ok: true })
    expect((await store.byId(id))!.disabledAt).toEqual(expect.any(Number))
    expect(await client.grants.enable(id)).toEqual({ ok: true })
    expect(await store.byId(id)).toEqual(updated.grant)
    const rotated = await client.grants.rotate(id, { endSessions: true })
    expect(rotated).toEqual({ id, token: rotated.token })
    expect(rotated.token === minted.token).toBe(false)
    expect((await store.byId(id))!.sessionsInvalidBefore).toEqual(expect.any(Number))
    expect((await client.grants.list({ active: true })).grants).toEqual([await store.byId(id)])
    expect(await client.grants.revoke(id)).toEqual({ ok: true })
    expect(await client.grants.list({ active: true })).toEqual({ grants: [] })
    expect(await client.grants.list()).toEqual({ grants: [await store.byId(id)] })
    expect(await client.logout()).toEqual({ ok: true })
  })

  it('passes activity and log filters to the configured audit query', async () => {
    const activity = { grantId: 'a/b', distinctIps: 0, countries: [], views: 0, firstSeen: null, lastSeen: null, topPaths: [] }
    const audit = { activity: vi.fn<AuditQuery['activity']>(async () => activity), recent: vi.fn<AuditQuery['recent']>(async () => []) }
    const { client } = await fixture({ audit })
    expect(await client.grants.activity('a/b')).toEqual(activity)
    expect(audit.activity.mock.calls).toEqual([['a/b']])
    expect(await client.log({ grant: 'a&b', limit: 7 })).toEqual({ events: [] })
    expect(audit.recent.mock.calls).toEqual([[{ grantId: 'a&b', limit: 7 }]])
  })

  it('retains real route errors and their status', async () => {
    const anonymous = await fixture({}, null)
    expect(await httpError(anonymous.client.whoami())).toEqual({
      name: 'AuthClientError', status: 401, body: { error: 'unauthenticated' },
    })
    const { client } = await fixture()
    const scoped = await fixture()
    const read = await scoped.gate.mint({ scopes: ['read'], createdBy: 'test' })
    const scopedHandle = authRoutes(scoped.gate)
    const fetch: typeof globalThis.fetch = async (input, init) => (await scopedHandle(new Request(
      new URL(String(input), 'https://app.test'), { ...init, headers: { authorization: `Bearer ${read.token}` } },
    )))!
    expect(await httpError(createAuthClient({ fetch }).grants.list())).toEqual({
      name: 'AuthClientError', status: 403, body: { error: 'forbidden' },
    })
    expect(await httpError(client.grants.update('missing', {}))).toEqual({
      name: 'AuthClientError', status: 404, body: { error: 'not found' },
    })
    expect(await httpError(client.grants.rotate('missing'))).toEqual({
      name: 'AuthClientError', status: 404, body: { error: 'not found' },
    })
    expect(await httpError(client.grants.activity('missing'))).toEqual({
      name: 'AuthClientError', status: 501, body: { error: 'audit query not configured' },
    })
    expect(await httpError(client.log())).toEqual({
      name: 'AuthClientError', status: 501, body: { error: 'audit query not configured' },
    })
  })

  it.each([
    ['{"error":"bad"}', { error: 'bad' }],
    ['{broken', '{broken'],
    ['upstream unavailable', 'upstream unavailable'],
    ['', null],
    ['null', null],
  ])('keeps a failing response body: %s', async (body, expected) => {
    const fetch: typeof globalThis.fetch = async () => new Response(body, { status: 502 })
    expect(await httpError(createAuthClient({ fetch }).whoami())).toEqual({
      name: 'AuthClientError', status: 502, body: expected,
    })
  })

  it('does not swallow an error status when reading its body fails', async () => {
    const response = new Response('', { status: 503 })
    vi.spyOn(response, 'text').mockRejectedValue(new Error('broken stream'))
    const fetch: typeof globalThis.fetch = async () => response
    expect(await httpError(createAuthClient({ fetch }).whoami())).toEqual({
      name: 'AuthClientError', status: 503, body: undefined,
    })
  })

  it('rejects malformed success JSON and unsafe IDs without fetching', async () => {
    const fetch = vi.fn(async () => new Response('{broken'))
    const client = createAuthClient({ fetch })
    await expect(client.whoami()).rejects.toBeInstanceOf(SyntaxError)
    fetch.mockClear()
    for (const id of ['', '.', '..']) expect(() => client.grants.revoke(id)).toThrow(TypeError)
    expect(fetch.mock.calls).toEqual([])
  })

  it('keeps empty successful bodies and network errors distinct from HTTP failures', async () => {
    // Transport fallback only: authRoutes always returns JSON, as the endpoint types require.
    const fetch: typeof globalThis.fetch = async () => new Response(null, { status: 204 })
    expect(await createAuthClient({ fetch }).logout()).toBe(null)
    const error = new Error('offline')
    const offline: typeof globalThis.fetch = async () => { throw error }
    await expect(createAuthClient({ fetch: offline }).whoami()).rejects.toBe(error)
  })
})

describe('shareUrl', () => {
  it('replaces every previous key while preserving the query and fragment', () => {
    expect(shareUrl('secret /&', 'https://app.test/slides/2?mode=present&key=old&key=other#title'))
      .toBe('https://app.test/slides/2?mode=present&key=secret+%2F%26#title')
  })

  it('uses the browser location by default and fails explicitly in SSR', () => {
    vi.stubGlobal('location', { href: 'https://app.test/page?x=1#part' })
    try { expect(shareUrl('token')).toBe('https://app.test/page?x=1&key=token#part') }
    finally { vi.unstubAllGlobals() }
    expect(() => shareUrl('token')).toThrow('shareUrl requires a target outside the browser')
  })
})
