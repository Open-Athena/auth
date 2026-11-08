import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { d1ClientRegistry } from '../src/adapters/d1-provider.js'
import { clientManagementRoutes, managementTokenAuth, hashClientSecret, type ManagementGrant, type ManagementPrincipal } from '../src/provider/index.js'
import { testDbRaw } from './d1-shim.js'
import broker from '../broker/src/index.js'

const NOW = 1_800_000_000
const TOKEN = 't'.repeat(43)
const CALLBACK = 'https://disky.oa.dev/auth/oa/callback'
const DEV = 'http://localhost:3871/auth/oa/callback'
const LOGOUT = 'https://disky.oa.dev/'
const ACTOR = 'agent:disky-registration'
const close: (() => void)[] = []
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW * 1000) })
afterEach(() => { close.splice(0).forEach(done => done()); vi.useRealTimers(); vi.restoreAllMocks() })

async function setup(change: Partial<ManagementGrant> = {}) {
  const { db, raw } = testDbRaw(['provider'])
  close.push(() => raw.close())
  const batch = db.batch.bind(db)
  let pending: Promise<unknown> = Promise.resolve()
  db.batch = <T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
    const next = pending.then(() => batch<T>(statements))
    pending = next.then(() => undefined, () => undefined)
    return next
  }
  const registry = d1ClientRegistry(db)
  const grant: ManagementGrant = {
    actor: ACTOR, tokenHash: await hashClientSecret(TOKEN), expiresAt: NOW + 60,
    actions: ['read', 'create', 'update', 'disable', 'enable', 'rotate'],
    clients: { 'oa-disky': { redirectUris: [CALLBACK, DEV], postLogoutRedirectUris: [LOGOUT] } }, ...change,
  }
  const authorize = managementTokenAuth([grant])
  const routes = clientManagementRoutes({ registry, authorize, redirectDomains: ['oa.dev'], reservedClientIds: ['static-app'] })
  const desired = { name: 'Disky', redirectUris: [CALLBACK], postLogoutRedirectUris: [LOGOUT], secretHash: await hashClientSecret('synthetic-client-secret') }
  const create = () => registry.create({ id: 'oa-disky', ...desired }, ACTOR)
  return { db, raw, registry, grant, routes, authorize, desired, create }
}
const request = (path = '', method = 'GET', body?: unknown, headers: Record<string, string> = {}) => new Request(`https://login.oa.dev/api/clients${path}`, {
  method, headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})
async function result(response: Response | null) {
  expect(response === null).toBe(false)
  return { status: response!.status, body: await response!.json(), cache: response!.headers.get('cache-control') }
}
const failure = (status: number, error: string) => ({ status, body: { error }, cache: 'no-store' })
const client = (patch: Record<string, unknown> = {}) => ({
  id: 'oa-disky', name: 'Disky', redirectUris: [CALLBACK], postLogoutRedirectUris: [LOGOUT], disabledAt: null,
  createdAt: NOW, createdBy: ACTOR, updatedAt: NOW, updatedBy: ACTOR, ...patch,
})

describe('scoped client management', () => {
  it.each(['', 'Bearer incorrect', `Bearer ${'f'.repeat(43)}`, 'Basic dGVzdA=='])('authorizes before storage or body reads: %s', async authorization => {
    const { routes, registry, desired } = await setup()
    const get = vi.spyOn(registry, 'get')
    const list = vi.spyOn(registry, 'list')
    const req = request('/oa-disky', 'PUT', desired, { authorization, cookie: 'oa_login=not-a-machine-credential' })
    expect(await result(await routes(req))).toEqual(failure(401, 'machine authorization required'))
    expect([get.mock.calls, list.mock.calls, req.bodyUsed]).toEqual([[], [], false])
  })

  it.each([NOW - 1, NOW])('expires at the exact deadline %s', async expiresAt => {
    const { routes } = await setup({ expiresAt })
    expect(await result(await routes(request()))).toEqual(failure(401, 'machine authorization required'))
  })

  it.each([{}, { actor: '' }, { actor: 'actor\n' }, { actions: ['admin'] }, { expiresAt: Infinity }, { expiresAt: 0 }, { tokenHash: 'bad' }, { clients: { '*': { redirectUris: [CALLBACK] } } }, { clients: { 'oa-disky': { redirectUris: [] } } }])('rejects malformed grants without echoing config %j', async patch => {
    const { grant } = await setup()
    const input = Object.keys(patch).length ? { ...grant, ...patch } : {}
    expect(() => managementTokenAuth([input as ManagementGrant])).toThrow('management: invalid grants')
  })

  it('snapshots grant config and returns copies rather than mutable live authority', async () => {
    const { grant } = await setup()
    const authorize = managementTokenAuth([grant])
    grant.actions.push('read')
    grant.clients.other = { redirectUris: [CALLBACK] }
    const first = await authorize(request()) as ManagementPrincipal
    expect(Object.keys(first.clients)).toEqual(['oa-disky'])
    first.clients.extra = { redirectUris: [CALLBACK] }
    expect(Object.keys((await authorize(request()) as ManagementPrincipal).clients)).toEqual(['oa-disky'])
  })

  it('rejects an array-valued hash rather than coercing it into a valid configuration', async () => {
    const { grant } = await setup()
    expect(() => managementTokenAuth([{ ...grant, tokenHash: [grant.tokenHash] } as unknown as ManagementGrant])).toThrow('management: invalid grants')
  })

  it.each([null, undefined, {}, [], { actor: 'fake', clients: {}, actions: ['root'] }])('fails closed for malformed auth hook results %j', async value => {
    const { registry } = await setup()
    const list = vi.spyOn(registry, 'list')
    const routes = clientManagementRoutes({ registry, redirectDomains: ['oa.dev'], authorize: async () => value as ManagementPrincipal })
    expect(await result(await routes(request()))).toEqual(failure(403, 'machine authorization required'))
    expect(list.mock.calls).toEqual([])
  })

  it('does not forward arbitrary authorization denial bodies', async () => {
    const { registry } = await setup()
    const routes = clientManagementRoutes({ registry, redirectDomains: ['oa.dev'], authorize: async () => Response.json({ secret: 'must-not-leak' }, { status: 403 }) })
    expect(await result(await routes(request()))).toEqual(failure(403, 'machine authorization required'))
  })

  it('creates with a caller-owned hash; retries do not generate or rotate a credential', async () => {
    const { routes, desired, registry } = await setup()
    expect(await result(await routes(request('/oa-disky', 'PUT', desired)))).toEqual({ status: 201, body: { client: client(), changed: true }, cache: 'no-store' })
    expect(await result(await routes(request('/oa-disky', 'PUT', desired)))).toEqual({ status: 200, body: { client: client(), changed: false }, cache: 'no-store' })
    expect(await registry.events()).toEqual([{ clientId: 'oa-disky', action: 'create', actor: ACTOR, at: NOW, detail: JSON.stringify([CALLBACK]) }])
    expect((await registry.get('oa-disky'))!.secretHash).toBe(desired.secretHash)
  })

  it.each(['secretHash', 'name', 'redirectUris'])('conflicting create %s returns 409 without mutation', async field => {
    const { routes, desired, create, registry } = await setup()
    await create()
    const changed = { ...desired, [field]: field === 'redirectUris' ? [DEV] : field === 'secretHash' ? await hashClientSecret('other-synthetic-secret') : 'Different name' }
    expect(await result(await routes(request('/oa-disky', 'PUT', changed)))).toEqual(failure(409, 'client already exists with different configuration'))
    expect([await registry.get('oa-disky'), (await registry.events()).map(e => e.action)]).toEqual([{ ...client(), secretHash: desired.secretHash }, ['create']])
  })

  it('lists only scoped clients and redacts hashes for list and detail', async () => {
    const { routes, desired, registry, create } = await setup()
    await create()
    await registry.create({ id: 'other', ...desired }, 'different-actor')
    expect(await result(await routes(request()))).toEqual({ status: 200, body: { clients: [client()] }, cache: 'no-store' })
    expect(await result(await routes(request('/oa-disky')))).toEqual({ status: 200, body: { client: client() }, cache: 'no-store' })
    expect(await result(await routes(request('/other')))).toEqual(failure(404, 'not found'))
  })

  it.each(['/other', '/static-app', '/oa-disky%2Fother'])('checks exact client scope before consulting storage %s', async path => {
    const { routes, registry } = await setup()
    const get = vi.spyOn(registry, 'get')
    expect(await result(await routes(request(path)))).toEqual(failure(404, 'not found'))
    expect(get.mock.calls).toEqual([])
  })

  it('never exposes static clients even when a capability accidentally includes their ID', async () => {
    const { routes, registry, desired, create } = await setup({ clients: {
      'oa-disky': { redirectUris: [CALLBACK], postLogoutRedirectUris: [LOGOUT] },
      'static-app': { redirectUris: [CALLBACK] },
    } })
    await create()
    await registry.create({ id: 'static-app', ...desired }, 'static-owner')
    const get = vi.spyOn(registry, 'get')
    expect(await result(await routes(request('/static-app')))).toEqual(failure(404, 'not found'))
    expect(get.mock.calls).toEqual([])
    expect(await result(await routes(request()))).toEqual({ status: 200, body: { clients: [client()] }, cache: 'no-store' })
  })

  it('projects metadata explicitly rather than serializing unknown adapter fields', async () => {
    const { routes, registry, desired } = await setup()
    vi.spyOn(registry, 'get').mockResolvedValue({ ...client(), secretHash: desired.secretHash, privateExtra: 'not-public' } as unknown as NonNullable<Awaited<ReturnType<typeof registry.get>>>)
    expect(await result(await routes(request('/oa-disky')))).toEqual({ status: 200, body: { client: client() }, cache: 'no-store' })
  })

  it('preserves callback capability AND deployment domain restrictions', async () => {
    const { routes, desired } = await setup()
    expect(await result(await routes(request('/oa-disky', 'PUT', { ...desired, redirectUris: ['https://other.oa.dev/cb'] })))).toEqual(failure(403, 'callback not allowed'))
    const second = await setup({ clients: { 'oa-disky': { redirectUris: ['https://evil.test/cb'] } } })
    expect(await result(await second.routes(request('/oa-disky', 'PUT', { ...second.desired, redirectUris: ['https://evil.test/cb'], postLogoutRedirectUris: [] })))).toEqual(failure(400, 'invalid callback URL'))
  })

  it('read-only authority cannot create or change clients', async () => {
    const { routes, desired, registry } = await setup({ actions: ['read'] })
    const create = vi.spyOn(registry, 'create')
    for (const [path, method, body] of [['/oa-disky', 'PUT', desired], ['/oa-disky', 'PATCH', desired], ['/oa-disky/rotate', 'POST', {}], ['/oa-disky/disable', 'POST', {}], ['/oa-disky/enable', 'POST', {}]] as const) {
      const req = request(path, method, body)
      expect(await result(await routes(req))).toEqual(failure(403, 'operation not allowed'))
      expect(req.bodyUsed).toBe(false)
    }
    expect(create.mock.calls).toEqual([])
  })

  it('updates allowed callbacks/name and audits the machine actor', async () => {
    const { routes, create, registry } = await setup()
    await create()
    const change = { name: 'Disky production', redirectUris: [CALLBACK, DEV], postLogoutRedirectUris: [] }
    expect(await result(await routes(request('/oa-disky', 'PATCH', change)))).toEqual({ status: 200, body: { client: client(change), changed: true }, cache: 'no-store' })
    expect(await result(await routes(request('/oa-disky', 'PATCH', change)))).toEqual({ status: 200, body: { client: client(change), changed: false }, cache: 'no-store' })
    expect((await registry.events()).map(e => [e.action, e.actor])).toEqual([['update', ACTOR], ['create', ACTOR]])
  })

  it('disables/enables explicitly; duplicate operations do not add audit rows', async () => {
    const { routes, create, registry } = await setup()
    await create()
    for (const action of ['disable', 'disable', 'enable', 'enable']) expect((await routes(request(`/oa-disky/${action}`, 'POST', {})))!.status).toBe(200)
    expect((await registry.events()).map(e => [e.action, e.actor])).toEqual([['enable', ACTOR], ['disable', ACTOR], ['create', ACTOR]])
    expect((await registry.get('oa-disky'))!.disabledAt).toBe(null)
  })

  it('concurrent duplicate disables commit only one transition and audit event', async () => {
    const { routes, create, registry } = await setup()
    await create()
    const get = registry.get.bind(registry)
    let reads = 0
    let release!: () => void
    const bothRead = new Promise<void>(resolve => { release = resolve })
    vi.spyOn(registry, 'get').mockImplementation(async id => {
      const value = await get(id)
      if (++reads <= 2) {
        if (reads === 2) release()
        await bothRead
      }
      return value
    })
    const results = await Promise.all([routes(request('/oa-disky/disable', 'POST', {})), routes(request('/oa-disky/disable', 'POST', {}))])
    expect((await Promise.all(results.map(r => r!.json() as Promise<{ changed: boolean }>))).map(r => r.changed).sort()).toEqual([false, true])
    expect((await registry.events()).map(e => e.action)).toEqual(['disable', 'create'])
  })

  it('rotates with CAS; retry is a no-op, stale expectation cannot replace it', async () => {
    const { routes, desired, registry, create } = await setup()
    await create()
    const secretHash = await hashClientSecret('synthetic-replacement')
    const rotation = { expectedSecretHash: desired.secretHash, secretHash }
    expect(await result(await routes(request('/oa-disky/rotate', 'POST', rotation)))).toEqual({ status: 200, body: { client: client(), changed: true }, cache: 'no-store' })
    expect(await result(await routes(request('/oa-disky/rotate', 'POST', rotation)))).toEqual({ status: 200, body: { client: client(), changed: false }, cache: 'no-store' })
    expect(await result(await routes(request('/oa-disky/rotate', 'POST', { ...rotation, secretHash: await hashClientSecret('newer-attempt') })))).toEqual(failure(409, 'secret changed; rotation refused'))
    expect([(await registry.get('oa-disky'))!.secretHash, (await registry.events()).map(e => [e.action, e.detail])]).toEqual([secretHash, [['rotate', null], ['create', JSON.stringify([CALLBACK])]]])
  })

  it('does not fall back to unsafe rotation for a custom adapter', async () => {
    const { registry, authorize, desired, create } = await setup()
    await create()
    registry.rotateIfCurrent = undefined
    const rotate = vi.spyOn(registry, 'rotate')
    const routes = clientManagementRoutes({ registry, authorize, redirectDomains: ['oa.dev'] })
    expect(await result(await routes(request('/oa-disky/rotate', 'POST', { expectedSecretHash: desired.secretHash, secretHash: await hashClientSecret('replacement') })))).toEqual(failure(501, 'atomic rotation not supported'))
    expect(rotate.mock.calls).toEqual([])
  })

  it('requires atomic state transitions from custom adapters', async () => {
    const { registry, authorize, create } = await setup()
    await create()
    registry.setDisabledIfChanged = undefined
    const setDisabled = vi.spyOn(registry, 'setDisabled')
    const routes = clientManagementRoutes({ registry, authorize, redirectDomains: ['oa.dev'] })
    expect(await result(await routes(request('/oa-disky/disable', 'POST', {})))).toEqual(failure(501, 'atomic state transition not supported'))
    expect(setDisabled.mock.calls).toEqual([])
  })

  it('rejects browser-origin writes, wrong media type, unknown fields and oversized bodies', async () => {
    const { routes, desired, registry } = await setup()
    expect(await result(await routes(request('/oa-disky', 'PUT', desired, { origin: 'https://login.oa.dev' })))).toEqual(failure(403, 'browser mutation refused'))
    expect(await result(await routes(request('/oa-disky', 'PUT', desired, { 'content-type': 'text/plain' })))).toEqual(failure(415, 'application/json required'))
    expect(await result(await routes(request('/oa-disky', 'PUT', { ...desired, client_secret: 'no-plaintext-here' })))).toEqual(failure(400, 'unexpected field'))
    expect(await result(await routes(request('/oa-disky', 'PUT', { name: 'x'.repeat(65536) })))).toEqual(failure(413, 'body too large'))
    expect(await registry.list()).toEqual([])
  })

  it('does not claim unrelated routes and rejects unsupported API operations', async () => {
    const { routes } = await setup()
    expect(await routes(new Request('https://login.oa.dev/other'))).toBe(null)
    expect(await routes(new Request('https://login.oa.dev/api/clients-other'))).toBe(null)
    expect(await result(await routes(request('/oa-disky', 'DELETE')))).toEqual(failure(405, 'method or route not supported'))
  })

  it.each(['{', 'null', '[]', '"text"'])('rejects non-object/malformed JSON %s', async body => {
    const { routes, registry } = await setup()
    expect(await result(await routes(new Request('https://login.oa.dev/api/clients/oa-disky', {
      method: 'PUT', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body,
    })))).toEqual(failure(400, 'JSON object required'))
    expect(await registry.list()).toEqual([])
  })

  it('broker disables the API unless grants are explicitly configured; malformed config fails closed', async () => {
    const { db, grant } = await setup()
    const env = { DB: db, WORKSPACE_DOMAIN: 'openathena.ai', CLIENT_REDIRECT_DOMAIN: 'oa.dev' }
    const req = () => new Request('http://localhost/api/clients', { headers: { authorization: `Bearer ${TOKEN}` } })
    expect(await result(await broker.fetch(req(), env))).toEqual(failure(404, 'not found'))
    expect(await result(await broker.fetch(req(), { ...env, CLIENT_MANAGEMENT_GRANTS: '{invalid' }))).toEqual(failure(503, 'client management unavailable'))
    expect(await result(await broker.fetch(req(), { ...env, CLIENT_MANAGEMENT_GRANTS: JSON.stringify([{ ...grant, tokenHash: [grant.tokenHash] }]) }))).toEqual(failure(503, 'client management unavailable'))
    expect(await result(await broker.fetch(req(), { ...env, CLIENT_MANAGEMENT_GRANTS: JSON.stringify([grant]) }))).toEqual({ status: 200, body: { clients: [] }, cache: 'no-store' })
  })
})
