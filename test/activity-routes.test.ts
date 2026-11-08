import { afterEach, describe, expect, it, vi } from 'vitest'
import { activityFeed, activityRoutes, DEFAULT_ACTIVITY_KINDS, type ActivityRoutesOptions } from '../src/activity/index.js'
import { d1ActivityStore } from '../src/adapters/d1-activity.js'
import { testDbRaw } from './d1-shim.js'

const close: (() => void)[] = []
afterEach(() => { close.splice(0).forEach(done => done()) })

function setup(requireAdmin: ActivityRoutesOptions['requireAdmin'] = async () => ({ who: 'admin@example.test' })) {
  const { db, raw } = testDbRaw(['activity'])
  close.push(() => raw.close())
  const store = d1ActivityStore(db)
  const feed = activityFeed({ store, now: () => 5000 })
  const routes = activityRoutes({ feed, store, requireAdmin })
  return { store, feed, routes, raw }
}

const request = (path = '', init?: RequestInit) => new Request(`https://admin.example/api/activity${path}`, init)
const put = (body: unknown, origin: string | null = 'https://admin.example') => ({
  method: 'PUT', headers: { 'content-type': 'application/json', ...(origin === null ? {} : { origin }) }, body: JSON.stringify(body),
})

async function result(response: Response | null) {
  expect(response === null).toBe(false)
  return { status: response!.status, body: await response!.json(), cache: response!.headers.get('cache-control') }
}

describe('activity admin routes with SQLite', () => {
  it('requires an authorization callback at construction', () => {
    const { feed, store } = setup()
    // Exercise JavaScript callers omitting the mandatory authorization hook.
    // @ts-expect-error requireAdmin is intentionally omitted
    expect(() => activityRoutes({ feed, store })).toThrow('activity: requireAdmin is required')
  })

  it.each([401, 403])('authorizes before every read, policy write, or body read (%s)', async status => {
    const requireAdmin = vi.fn(async () => Response.json({ error: 'denied' }, { status }))
    const { routes, store } = setup(requireAdmin)
    const list = vi.spyOn(store, 'list')
    const get = vi.spyOn(store, 'get')
    const kinds = vi.spyOn(store, 'readKinds')
    const write = vi.spyOn(store, 'writeKind')
    const requests = [request(), request('/one'), request('/kinds'), request('/kinds/view', put({ record: 'off', notify: 'off' }))]
    for (const req of requests) {
      expect(await result(await routes(req))).toEqual({ status, body: { error: 'denied' }, cache: 'no-store' })
      expect(req.bodyUsed).toBe(false)
    }
    expect([requireAdmin.mock.calls.length, list.mock.calls, get.mock.calls, kinds.mock.calls, write.mock.calls]).toEqual([4, [], [], [], []])
    expect(await routes(new Request('https://admin.example/api/activity-other'))).toBe(null)
    expect(requireAdmin.mock.calls.length).toBe(4)
  })

  it.each([undefined, null, {}, [], false, { who: '' }, { who: '  ' }, { who: 42 }])('fails closed for invalid authorization principal %j', async principal => {
    const { routes, store, raw } = setup((async () => principal) as unknown as ActivityRoutesOptions['requireAdmin'])
    const list = vi.spyOn(store, 'list')
    const read = vi.spyOn(store, 'readKinds')
    const write = vi.spyOn(store, 'writeKind')
    expect(await result(await routes(request()))).toEqual({ status: 403, body: { error: 'admin required' }, cache: 'no-store' })
    expect(await result(await routes(request('/kinds/view', put({ record: 'off', notify: 'off' }))))).toEqual({ status: 403, body: { error: 'admin required' }, cache: 'no-store' })
    expect([list.mock.calls, read.mock.calls, write.mock.calls]).toEqual([[], [], []])
    expect(raw.prepare('SELECT * FROM activity_kinds').all()).toEqual([])
  })

  it('lists, filters, and reads actual stored bursts without sending notifications', async () => {
    const { routes, feed, raw } = setup()
    const actor = { id: 'actor:a', name: 'Alice', via: 'google' }
    const first = await feed.record({ id: 'one', actor, origin: 'https://app.example', ts: 1000, kind: 'view', line: 'Opened report', path: '/report?secret=x' })
    await feed.record({ id: 'two', actor: { ...actor, id: 'actor:b' }, origin: 'https://other.example', ts: 2000, kind: 'click' })
    const expected = {
      id: first.burstId, actor, origin: 'https://app.example', firstTs: 1000, lastTs: 1000, receivedTs: 5000, version: 1,
      counts: { view: 1 }, notifyCounts: { view: 1 }, omittedLines: 0,
      lines: [{ id: 'one', ts: 1000, kind: 'view', line: 'Opened report', path: '/report', sessionId: null, notify: 'count' }],
    }
    expect(await result(await routes(request('?actorId=actor%3Aa&origin=https%3A%2F%2Fapp.example&since=1000&limit=1')))).toEqual({ status: 200, body: { bursts: [expected] }, cache: 'no-store' })
    expect(await result(await routes(request(`/${first.burstId}`)))).toEqual({ status: 200, body: { burst: expected }, cache: 'no-store' })
    expect(await result(await routes(request('?since=2001')))).toEqual({ status: 200, body: { bursts: [] }, cache: 'no-store' })
    expect(await result(await routes(request('/missing')))).toEqual({ status: 404, body: { error: 'not found' }, cache: 'no-store' })
    expect(raw.prepare('SELECT * FROM activity_posts').all()).toEqual([])
  })

  it('reads defaults and persists declared-kind overrides without rewriting existing events', async () => {
    const { routes, feed, raw } = setup()
    await feed.record({ id: 'one', actor: { id: 'a', name: 'A', via: 'google' }, origin: 'https://app.example', ts: 1000, kind: 'view', line: 'Before change' })
    expect(await result(await routes(request('/kinds')))).toEqual({ status: 200, body: { kinds: DEFAULT_ACTIVITY_KINDS }, cache: 'no-store' })
    expect(await result(await routes(request('/kinds/view', put({ record: 'off', notify: 'off' }))))).toEqual({
      status: 200, body: { kinds: { ...DEFAULT_ACTIVITY_KINDS, view: { record: 'off', notify: 'off' } } }, cache: 'no-store',
    })
    expect(raw.prepare('SELECT kind, record, notify FROM activity_kinds').all()).toEqual([{ kind: 'view', record: 'off', notify: 'off' }])
    expect(raw.prepare('SELECT kind, record, notify, line FROM activity_events').all()).toEqual([{ kind: 'view', record: 'line', notify: 'count', line: 'Before change' }])
  })

  it.each([null, 'null', 'https://evil.example', 'https://admin.example.evil', 'http://admin.example'])('rejects PUT from Origin %s before consuming its body', async origin => {
    const { routes, raw } = setup()
    const req = request('/kinds/view', put({ record: 'off', notify: 'off' }, origin))
    expect(await result(await routes(req))).toEqual({ status: 403, body: { error: 'cross-origin mutation refused' }, cache: 'no-store' })
    expect(req.bodyUsed).toBe(false)
    expect(raw.prepare('SELECT * FROM activity_kinds').all()).toEqual([])
  })

  it.each([
    ['?limit=0', 'invalid limit'], ['?limit=501', 'invalid limit'], ['?limit=1.5', 'invalid limit'],
    ['?limit=1e2', 'invalid limit'], ['?since=-1', 'invalid since'], ['?since=9007199254740992', 'invalid since'],
    ['?since=', 'invalid since'], ['?actorId=%20', 'invalid actorId'], ['?origin=%00', 'invalid origin'],
    ['?actorId=' + 'x'.repeat(513), 'invalid actorId'], ['/%ZZ', 'invalid burst id'],
  ])('rejects invalid input %s', async (path, error) => {
    const { routes } = setup()
    expect(await result(await routes(request(path)))).toEqual({ status: 400, body: { error }, cache: 'no-store' })
  })

  it.each([
    [null, 'invalid policy'], [[], 'invalid policy'], [{ record: 'off' }, 'invalid policy'],
    [{ record: 'off', notify: 'off', extra: true }, 'invalid policy'],
    [{ record: { toString: null }, notify: 'off' }, 'invalid policy'],
    [{ record: 'off', notify: 'line' }, 'invalid kind or policy'],
    [{ record: 'bogus', notify: 'off' }, 'invalid policy'],
  ])('rejects invalid policy %j without writes', async (body, error) => {
    const { routes, raw } = setup()
    expect(await result(await routes(request('/kinds/view', put(body))))).toEqual({ status: 400, body: { error }, cache: 'no-store' })
    expect(raw.prepare('SELECT * FROM activity_kinds').all()).toEqual([])
  })

  it.each(['/kinds/unknown', '/kinds/%ZZ', '/kinds/view%2Fother'])('rejects invalid or undeclared kind %s', async path => {
    const { routes } = setup()
    expect(await result(await routes(request(path, put({ record: 'off', notify: 'off' }))))).toEqual({ status: 400, body: { error: 'invalid kind or policy' }, cache: 'no-store' })
  })

  it('bounds bytes before decoding, cancels oversized streams, and handles broken JSON', async () => {
    const { routes } = setup()
    for (const [body, status, error] of [['{', 400, 'invalid JSON'], [' '.repeat(4097), 413, 'body too large'], ['"' + 'é'.repeat(2048) + '"', 413, 'body too large']] as const) {
      expect(await result(await routes(request('/kinds/view', { method: 'PUT', headers: { origin: 'https://admin.example' }, body })))).toEqual({ status, body: { error }, cache: 'no-store' })
    }
    const cancel = vi.fn()
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(4097)) }, cancel,
    }, { highWaterMark: 0 })
    const req = request('/kinds/view', { method: 'PUT', headers: { origin: 'https://admin.example' }, body: stream, duplex: 'half' } as RequestInit)
    expect(await result(await routes(req))).toEqual({ status: 413, body: { error: 'body too large' }, cache: 'no-store' })
    expect(cancel.mock.calls).toEqual([[undefined]])
    expect(await result(await routes(request('/kinds/view', {
      method: 'PUT', headers: { origin: 'https://admin.example', 'content-length': '4097' }, body: '{}',
    })))).toEqual({ status: 413, body: { error: 'body too large' }, cache: 'no-store' })
  })

  it('can mount at a custom path and never exposes public event ingestion', async () => {
    const { feed, store, routes } = setup()
    const mounted = activityRoutes({ feed, store, requireAdmin: async () => ({ who: 'staff' }), basePath: '/staff/activity/' })
    expect(await result(await mounted(new Request('https://admin.example/staff/activity')))).toEqual({ status: 200, body: { bursts: [] }, cache: 'no-store' })
    for (const path of ['', '/events', '/kinds/view']) {
      expect(await result(await routes(request(path, { ...put({ id: 'untrusted' }), method: 'POST' })))).toEqual({ status: 404, body: { error: 'not found' }, cache: 'no-store' })
    }
  })
})
