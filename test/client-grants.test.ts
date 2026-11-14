import { describe, expect, it, vi } from 'vitest'
import { AuthClientError, createAuthClient } from '../src/client/api.js'
import type { AuthClient } from '../src/client/api.js'
import { subscribeUnauthenticated } from '../src/client/auth-events.js'
import { createGrantsController } from '../src/client/grants.js'
import type { GrantsSnapshot } from '../src/client/grants.js'
import { createGate } from '../src/core/gate.js'
import type { Grant } from '../src/core/http.js'
import { authRoutes } from '../src/core/routes.js'
import type { AuditQuery } from '../src/core/store.js'
import { memoryGrantStore } from '../src/testing/index.js'

async function fixture() {
  const store = memoryGrantStore()
  const gate = createGate({ store, secret: 'client-test-secret-0123456789', adminEmails: ['admin@example.com'] })
  const signed = (await gate.signIn('admin@example.com', new Request('https://app.test/')))!
  const audit: AuditQuery = {
    activity: async grantId => ({ grantId, distinctIps: 0, countries: [], views: 0, firstSeen: null, lastSeen: null, topPaths: [] }),
    recent: async () => [],
  }
  const handle = authRoutes(gate, { audit })
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const headers = new Headers(init?.headers)
    headers.set('cookie', signed.cookie.split(';')[0]!)
    return (await handle(new Request(new URL(String(input), 'https://app.test'), { ...init, headers })))!
  }
  const client = createAuthClient({ fetch })
  return { store, client, controller: createGrantsController({ client }) }
}

/** Every requested response is held until the test settles it. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const grant = (id: string, o: Partial<Grant> = {}): Grant => ({
  id,
  name: null,
  note: null,
  subject: null,
  email: null,
  scopes: ['read'],
  maxRedeems: null,
  redeems: 0,
  expiresAt: null,
  sessionTtlS: null,
  createdAt: 1,
  createdBy: 'admin@example.com',
  disabledAt: null,
  revokedAt: null,
  expiryEndsSessions: true,
  sessionsInvalidBefore: null,
  firstUsedAt: null,
  lastUsedAt: null,
  service: false,
  anon: false,
  ...o,
})

/** A client whose grant routes are stubs, for ordering responses by hand. */
function scripted(grants: Partial<AuthClient['grants']>): AuthClient {
  return { basePath: '/api/auth', grants } as unknown as AuthClient
}

const flush = () => new Promise(resolve => setTimeout(resolve))

/** The real routes verify cookies with WebCrypto, so "the list landed" takes real time. */
const settled = (controller: ReturnType<typeof createGrantsController>) =>
  vi.waitFor(() => expect(controller.getSnapshot().loading).toBe(false))

/** The fields that move during an action, one entry per change a subscriber saw. */
function trace(controller: ReturnType<typeof createGrantsController>) {
  const seen: Pick<GrantsSnapshot, 'loading' | 'minting' | 'pending'>[] = []
  controller.subscribe(() => {
    const { loading, minting, pending } = controller.getSnapshot()
    seen.push({ loading, minting, pending })
  })
  return seen
}

describe('createGrantsController', () => {
  it('starts empty, and loads the list', async () => {
    const { controller, client } = await fixture()
    expect(controller.getSnapshot()).toEqual({
      grants: [], loaded: false, loading: false, minting: false, pending: {}, error: null, token: null, activities: {},
    })
    const { grant: minted } = await client.grants.mint({ name: 'Board', scopes: ['read'], avatar: null })
    await controller.refresh()
    expect(controller.getSnapshot()).toEqual({
      grants: [minted], loaded: true, loading: false, minting: false, pending: {}, error: null, token: null, activities: {},
    })
  })

  it('mint: exact transitions, the token held until dismissed and absent from every list', async () => {
    const { controller, store } = await fixture()
    const seen = trace(controller)
    const minted = await controller.mint({ name: 'Board', scopes: ['read'], avatar: null })
    expect(minted).toEqual(await store.byId(minted!.id))
    expect(Object.keys(minted!).includes('token')).toBe(false)
    await settled(controller)
    expect(seen).toEqual([
      { loading: false, minting: true, pending: {} },
      { loading: false, minting: false, pending: {} },
      { loading: true, minting: false, pending: {} },
      { loading: false, minting: false, pending: {} },
    ])
    const { token } = controller.getSnapshot()
    expect(token).toEqual({ grantId: minted!.id, token: expect.any(String), source: 'mint' })
    expect(controller.getSnapshot().grants).toEqual([minted])
    expect(JSON.stringify(controller.getSnapshot().grants).includes(token!.token)).toBe(false)

    await controller.refresh()
    expect(controller.getSnapshot().token).toEqual(token)
    controller.dismissToken()
    expect(controller.getSnapshot().token).toBe(null)
  })

  it('a failed mint reports the route\'s reason, returns null, and leaves an earlier token alone', async () => {
    const { controller } = await fixture()
    await controller.mint({ name: 'First', scopes: ['read'], avatar: null })
    await settled(controller)
    const earlier = controller.getSnapshot().token
    const seen = trace(controller)
    expect(await controller.mint({ name: 'None', scopes: [], avatar: null })).toBe(null)
    await settled(controller)
    expect(seen).toEqual([
      { loading: false, minting: true, pending: {} },
      { loading: false, minting: false, pending: {} },
      { loading: true, minting: false, pending: {} },
      { loading: false, minting: false, pending: {} },
    ])
    const { error, token, grants } = controller.getSnapshot()
    expect({ action: error!.action, grantId: error!.grantId, message: error!.message }).toEqual({
      action: 'mint', grantId: null, message: 'scopes required',
    })
    expect(token).toEqual(earlier)
    expect(grants.map(g => g.name)).toEqual(['First'])
  })

  it('rotate: pending on that link, a fresh token that replaces the last, old token dead', async () => {
    const { controller } = await fixture()
    const minted = (await controller.mint({ name: 'Board', scopes: ['read'], avatar: null }))!
    await settled(controller)
    const first = controller.getSnapshot().token!
    const seen = trace(controller)
    expect(await controller.rotate(minted.id)).toBe(true)
    await settled(controller)
    expect(seen).toEqual([
      { loading: false, minting: false, pending: { [minted.id]: 'rotate' } },
      { loading: false, minting: false, pending: {} },
      { loading: true, minting: false, pending: {} },
      { loading: false, minting: false, pending: {} },
    ])
    const { token } = controller.getSnapshot()
    expect(token).toEqual({ grantId: minted.id, token: expect.any(String), source: 'rotate' })
    expect(token!.token === first.token).toBe(false)
  })

  it('revoking the link whose token is showing clears it; revoking another does not', async () => {
    const { controller } = await fixture()
    const a = (await controller.mint({ name: 'A', scopes: ['read'], avatar: null }))!
    await settled(controller)
    const b = (await controller.mint({ name: 'B', scopes: ['read'], avatar: null }))!
    await settled(controller)
    expect(await controller.revoke(a.id)).toBe(true)
    await settled(controller)
    expect(controller.getSnapshot().token?.grantId).toBe(b.id)
    expect(await controller.revoke(b.id)).toBe(true)
    await settled(controller)
    expect(controller.getSnapshot().token).toBe(null)
    expect(controller.getSnapshot().grants.map(g => g.revokedAt !== null)).toEqual([true, true])
  })

  it('disable, enable and update reach the list; activity is kept per link', async () => {
    const { controller } = await fixture()
    const { id } = (await controller.mint({ name: 'Board', scopes: ['read'], avatar: null }))!
    await settled(controller)
    await controller.disable(id)
    await settled(controller)
    expect(controller.getSnapshot().grants[0]!.disabledAt).toEqual(expect.any(Number))
    await controller.enable(id)
    await settled(controller)
    expect(controller.getSnapshot().grants[0]!.disabledAt).toBe(null)
    await controller.update(id, { subjectName: 'Ada' })
    expect(controller.getSnapshot().grants[0]!.subject).toEqual({ name: 'Ada' })
    await settled(controller)
    await controller.activity(id)
    expect(controller.getSnapshot().activities).toEqual({
      [id]: { grantId: id, distinctIps: 0, countries: [], views: 0, firstSeen: null, lastSeen: null, topPaths: [] },
    })
  })

  it('a list that left before a revoke finished cannot bring back the old state', async () => {
    const stale = deferred<{ grants: Grant[] }>()
    const fresh = deferred<{ grants: Grant[] }>()
    const lists = [stale, fresh]
    const revoke = deferred<{ ok: boolean }>()
    const controller = createGrantsController({
      client: scripted({ list: () => lists.shift()!.promise, revoke: () => revoke.promise } as Partial<AuthClient['grants']>),
    })
    const refreshed = controller.refresh()
    const revoked = controller.revoke('a')
    revoke.resolve({ ok: true })
    await revoked
    // Finishes out of order: the fresh list lands, then the one from before the revoke.
    fresh.resolve({ grants: [grant('a', { revokedAt: 100 })] })
    await flush()
    expect(controller.getSnapshot().grants).toEqual([grant('a', { revokedAt: 100 })])
    stale.resolve({ grants: [grant('a')] })
    await refreshed
    const { grants, loading } = controller.getSnapshot()
    expect(grants).toEqual([grant('a', { revokedAt: 100 })])
    expect(loading).toBe(false)
  })

  it('a stale list cannot drop a link just minted, and a stale failure is not reported', async () => {
    const stale = deferred<{ grants: Grant[] }>()
    const fresh = deferred<{ grants: Grant[] }>()
    const lists = [stale, fresh]
    const controller = createGrantsController({
      client: scripted({
        list: () => lists.shift()!.promise,
        mint: async () => ({ grant: grant('new'), token: 't' }),
      } as Partial<AuthClient['grants']>),
    })
    const refreshed = controller.refresh()
    await controller.mint({ scopes: ['read'] })
    stale.reject(new Error('from before the mint'))
    await refreshed
    expect(controller.getSnapshot().grants).toEqual([grant('new')])
    expect(controller.getSnapshot().error).toBe(null)
    fresh.resolve({ grants: [grant('new')] })
    await flush()
    expect(controller.getSnapshot().loading).toBe(false)
  })

  it('a list that works clears only a list failure, not a change\'s', async () => {
    const lists: (() => Promise<{ grants: Grant[] }>)[] = [
      () => Promise.reject(new Error('list down')),
      async () => ({ grants: [] }),
      async () => ({ grants: [] }),
    ]
    const controller = createGrantsController({
      client: scripted({
        list: () => lists.shift()!(),
        revoke: () => Promise.reject(new AuthClientError(404, { error: 'not found' })),
      } as Partial<AuthClient['grants']>),
    })
    await controller.refresh()
    expect(controller.getSnapshot().error?.message).toBe('list down')
    await controller.refresh()
    expect(controller.getSnapshot().error).toBe(null)
    expect(await controller.revoke('a')).toBe(false)
    await flush()
    const { error, pending } = controller.getSnapshot()
    expect({ action: error?.action, grantId: error?.grantId, message: error?.message }).toEqual({
      action: 'revoke', grantId: 'a', message: 'not found',
    })
    expect(pending).toEqual({})
  })

  it('refuses a second change to a link with one in flight', async () => {
    const revoke = deferred<{ ok: boolean }>()
    const disable = vi.fn()
    const controller = createGrantsController({
      client: scripted({ list: async () => ({ grants: [] }), revoke: () => revoke.promise, disable } as Partial<AuthClient['grants']>),
    })
    const revoked = controller.revoke('a')
    expect(await controller.disable('a')).toBe(false)
    expect(disable.mock.calls).toEqual([])
    revoke.resolve({ ok: true })
    expect(await revoked).toBe(true)
  })

  it('an activity failure is reported, but never displaces a change\'s', async () => {
    const controller = createGrantsController({
      client: scripted({
        list: async () => ({ grants: [] }),
        revoke: () => Promise.reject(new AuthClientError(409, { error: 'revoke refused' })),
        activity: () => Promise.reject(new AuthClientError(404, { error: 'no audit' })),
      } as Partial<AuthClient['grants']>),
    })
    await controller.activity('a')
    expect(controller.getSnapshot().error?.action).toBe('activity')
    await controller.revoke('a')
    await controller.activity('a')
    await flush()
    expect(controller.getSnapshot().error?.message).toBe('revoke refused')
  })

  it('a 401 tells this gate\'s whoami to look again', async () => {
    const events: unknown[] = []
    const off = subscribeUnauthenticated(event => events.push(event))
    const controller = createGrantsController({
      client: { ...scripted({ list: () => Promise.reject(new AuthClientError(401, { error: 'unauthenticated', reason: 'revoked' })) }), basePath: '/api/admin' },
    })
    await controller.refresh()
    off()
    expect(events).toEqual([{ reason: 'revoked', endpoint: '/api/admin/whoami' }])
  })

  it('unsubscribed listeners hear nothing, and each change is a new snapshot', async () => {
    const { controller } = await fixture()
    const heard = vi.fn()
    const off = controller.subscribe(heard)
    const before = controller.getSnapshot()
    const pending = controller.refresh()
    expect(controller.getSnapshot() === before).toBe(false)
    await pending
    const calls = heard.mock.calls.length
    off()
    await controller.refresh()
    expect(heard.mock.calls.length).toBe(calls)
  })
})

describe('createAuthClient logout', () => {
  it('sends the selection it is given, over the one it last saw', async () => {
    const headers: (string | null)[] = []
    const client = createAuthClient({
      basePath: '/api/view/',
      fetch: async (_input, init) => {
        headers.push(new Headers(init?.headers).get('X-OA-Selection-Context'))
        return new Response(JSON.stringify({ ok: true, selection: 'seen' }))
      },
    })
    expect(client.basePath).toBe('/api/view')
    await client.logout()
    await client.logout()
    await client.logout({ selection: 'given' })
    expect(headers).toEqual([null, 'seen', 'given'])
  })
})
