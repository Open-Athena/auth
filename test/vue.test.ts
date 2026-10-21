// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://x.test/" }
import { createApp, defineComponent, h, nextTick, ref } from 'vue'
import type { App } from 'vue'
import { afterEach, expect, it, vi } from 'vitest'
import { AuthGate, reportUnauthenticated, useWhoami } from '../src/vue/index.js'
import type { UseWhoamiResult } from '../src/vue/index.js'
import type { Whoami } from '../src/client/identity.js'

const identity: Whoami = { kind: 'sso', email: 'staff@example.test', scopes: [], admin: false, subject: null }
const apps: App[] = []
const flush = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await nextTick() }
function mount(component: Parameters<typeof createApp>[0]) {
  const element = document.createElement('div')
  document.body.append(element)
  const app = createApp(component)
  apps.push(app)
  app.mount(element)
  return { app, element }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const response = (status = 200) => new Response(JSON.stringify(identity), { status })
afterEach(() => {
  apps.splice(0).forEach(app => app.unmount())
  document.body.replaceChildren()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  window.history.replaceState({}, '', '/')
})

it('renders exact slot transitions for identity, 401, and server errors', async () => {
  let status = 200
  vi.stubGlobal('fetch', vi.fn(async () => response(status)))
  let auth!: UseWhoamiResult
  const { element } = mount(defineComponent({
    setup() {
      auth = useWhoami()
      return () => h(AuthGate, { options: { exchange: false } }, {
        loading: () => 'loading',
        default: ({ whoami }: { whoami: Whoami }) => whoami.email,
        unauthenticated: () => 'signed out',
        error: ({ error }: { error: Error }) => error.message,
      })
    },
  }))
  expect(element.textContent).toBe('loading')
  await flush()
  expect(element.textContent).toBe('staff@example.test')
  status = 401
  await auth.refetch()
  await nextTick()
  expect([element.textContent, auth.whoami.value, auth.loading.value, auth.error.value]).toEqual(['signed out', null, false, null])
  status = 500
  await auth.refetch()
  await nextTick()
  expect(element.textContent).toBe('Auth request failed (500)')
})

it('shares within an app, isolates apps, and refreshes signed-out state on focus', async () => {
  let status = 401
  const fetch = vi.fn(async () => response(status))
  vi.stubGlobal('fetch', fetch)
  const results: UseWhoamiResult[] = []
  const child = defineComponent({ setup() { results.push(useWhoami()); return () => null } })
  mount(defineComponent({ setup: () => () => [h(child), h(child)] }))
  await flush()
  expect([fetch.mock.calls.length, results[0] === results[1]]).toEqual([1, true])
  status = 200
  window.dispatchEvent(new Event('focus'))
  await flush()
  expect([fetch.mock.calls.length, results[0]!.whoami.value]).toEqual([2, identity])
  window.dispatchEvent(new Event('focus'))
  await flush()
  expect(fetch.mock.calls.length).toBe(2)
  mount(child)
  await flush()
  expect([fetch.mock.calls.length, results[0] === results[2]]).toEqual([3, false])
})

it('ignores obsolete probes after refetch, logout, and unmount', async () => {
  const requests: ReturnType<typeof deferred<Response>>[] = []
  vi.stubGlobal('fetch', vi.fn(() => {
    const request = deferred<Response>()
    requests.push(request)
    return request.promise
  }))
  let auth!: UseWhoamiResult
  const { app } = mount(defineComponent({ setup() { auth = useWhoami(); return () => null } }))
  const refresh = auth.refetch()
  requests[1]!.resolve(response(401))
  await refresh
  requests[0]!.resolve(response())
  await flush()
  expect([auth.whoami.value, auth.error.value, auth.loading.value]).toEqual([null, null, false])
  const pending = auth.refetch()
  const logout = auth.signOut()
  requests[3]!.resolve(new Response('{"ok":true}'))
  await logout
  requests[2]!.resolve(response())
  await pending
  expect(auth.whoami.value).toBe(null)
  const last = auth.refetch()
  app.unmount()
  apps.splice(apps.indexOf(app), 1)
  requests[4]!.resolve(response())
  await last
  expect([auth.whoami.value, auth.loading.value, auth.error.value]).toEqual([undefined, true, null])
  window.dispatchEvent(new Event('focus'))
  expect(requests.length).toBe(5)
})

it('strips and exchanges a key before probing multiple gates', async () => {
  window.history.replaceState({}, '', '/?key=SECRET&tab=2#plot')
  const exchange = deferred<Response>()
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    calls.push(url)
    return url === '/api/auth/exchange' ? exchange.promise : Promise.resolve(response())
  }))
  mount(defineComponent({ setup: () => () => [h(AuthGate), h(AuthGate)] }))
  expect([calls, window.location.href]).toEqual([['/api/auth/exchange'], 'https://x.test/?tab=2#plot'])
  exchange.resolve(new Response('{}'))
  await flush()
  expect(calls).toEqual(['/api/auth/exchange', '/api/auth/whoami'])
})

it('preserves identity and exposes failed logout without swallowing the rejection', async () => {
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(url)
    return response(url.endsWith('/logout') ? 503 : 200)
  }))
  let auth!: UseWhoamiResult
  mount(defineComponent({ setup() {
    auth = useWhoami({ basePath: '/custom/auth/' })
    return () => null
  } }))
  await flush()
  await expect(auth.signOut()).rejects.toMatchObject({ status: 503 })
  expect([auth.whoami.value, auth.loading.value, auth.error.value?.message, calls]).toEqual([
    identity, false, 'Auth request failed (503)', ['/custom/auth/whoami', '/custom/auth/logout'],
  ])
})

it('defaults key exchange to the configured base path', async () => {
  window.history.replaceState({}, '', '/?key=SECRET')
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(url)
    return url.endsWith('/exchange') ? new Response('{}') : response()
  }))
  mount(defineComponent({ setup: () => () => h(AuthGate, { options: { basePath: '/custom/auth/' } }) }))
  await flush()
  expect([calls, window.location.search]).toEqual([
    ['/custom/auth/exchange', '/custom/auth/whoami'], '',
  ])
})

it('falls back to the unauthenticated slot with error and refetch', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response(500)))
  const { element } = mount(defineComponent({ setup: () => () => h(AuthGate, {}, {
    unauthenticated: ({ error, refetch }: { error: Error; refetch: unknown }) => `${error.message}:${typeof refetch}`,
  }) }))
  await flush()
  expect(element.textContent).toBe('Auth request failed (500):function')
})

it('supersedes a non-exchanging consumer probe after key exchange', async () => {
  window.history.replaceState({}, '', '/?key=SECRET')
  const exchange = deferred<Response>()
  const oldProbe = deferred<Response>()
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    calls.push(url)
    if (url.endsWith('/exchange')) return exchange.promise
    return calls.length === 1 ? oldProbe.promise : Promise.resolve(response())
  }))
  let auth!: UseWhoamiResult
  const consumer = defineComponent({ setup() { auth = useWhoami(); return () => null } })
  mount(defineComponent({ setup: () => () => [h(consumer), h(AuthGate)] }))
  expect(calls).toEqual(['/api/auth/whoami', '/api/auth/exchange'])
  exchange.resolve(new Response('{}'))
  await flush()
  oldProbe.resolve(response(401))
  await flush()
  expect([calls, auth.whoami.value, auth.loading.value]).toEqual([
    ['/api/auth/whoami', '/api/auth/exchange', '/api/auth/whoami'], identity, false,
  ])
})

it('keeps different apps identities isolated when one app signs out', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response()))
  const results: UseWhoamiResult[] = []
  const component = defineComponent({ setup() { results.push(useWhoami()); return () => null } })
  mount(component)
  mount(component)
  await flush()
  await results[0]!.signOut()
  expect(results.map(auth => [auth.whoami.value, auth.loading.value, auth.error.value])).toEqual([
    [null, false, null], [identity, false, null],
  ])
})

it.each([200, 503])('reuses in-flight logout across consumer remount (status %s)', async status => {
  const logout = deferred<Response>()
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    calls.push(url)
    return url.endsWith('/logout') ? logout.promise : Promise.resolve(response())
  }))
  const shown = ref(true)
  const results: UseWhoamiResult[] = []
  const child = defineComponent({ setup() { results.push(useWhoami()); return () => null } })
  mount(defineComponent({ setup: () => () => shown.value ? h(child) : null }))
  await flush()
  const signingOut = results[0]!.signOut().then(() => 'ok', error => error.message)
  shown.value = false
  await nextTick()
  shown.value = true
  await nextTick()
  window.dispatchEvent(new Event('focus'))
  expect([results[0] === results[1], calls]).toEqual([true, ['/api/auth/whoami', '/api/auth/logout']])
  logout.resolve(response(status))
  expect(await signingOut).toBe(status === 200 ? 'ok' : 'Auth request failed (503)')
  await flush()
  expect([results[1]!.whoami.value, results[1]!.loading.value, results[1]!.error.value?.message ?? null, calls]).toEqual([
    status === 200 ? null : undefined, false, status === 200 ? null : 'Auth request failed (503)',
    ['/api/auth/whoami', '/api/auth/logout'],
  ])
})

it('keeps the identity until a reported failure is authoritatively confirmed', async () => {
  const probe = deferred<Response>()
  const fetch = vi.fn().mockResolvedValueOnce(response()).mockReturnValueOnce(probe.promise).mockResolvedValue(response())
  vi.stubGlobal('fetch', fetch)
  let auth!: UseWhoamiResult
  mount(defineComponent({ setup() {
    auth = useWhoami()
    return () => null
  } }))
  await flush()
  reportUnauthenticated('revoked')
  expect([auth.whoami.value, auth.reason.value, fetch.mock.calls.length]).toEqual([identity, 'revoked', 2])
  probe.resolve(new Response('{"error":"unauthenticated"}', { status: 401 }))
  await flush()
  expect([auth.whoami.value, auth.reason.value, auth.error.value]).toEqual([null, 'revoked', null])
})

it('passes the retained report reason to the unauthenticated gate slot', async () => {
  let status = 200
  vi.stubGlobal('fetch', vi.fn(async () => status === 200 ? response() : new Response('{"error":"unauthenticated"}', { status })))
  const { element } = mount(defineComponent({ setup: () => () => h(AuthGate, { options: { exchange: false } }, {
    default: () => 'signed in',
    unauthenticated: ({ reason }: { reason: string | null }) => `signed out:${reason}`,
  }) }))
  await flush()
  status = 401
  reportUnauthenticated('revoked')
  await flush()
  expect(element.textContent).toBe('signed out:revoked')
})

it('isolates reports by endpoint and clears reasons after a healthy authoritative probe', async () => {
  const calls: string[] = []
  const probe = deferred<Response>()
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    calls.push(url)
    return calls.length > 2 ? probe.promise : Promise.resolve(response())
  }))
  const results: UseWhoamiResult[] = []
  mount(defineComponent({ setup() {
    results.push(useWhoami(), useWhoami({ basePath: '/other/' }))
    return () => null
  } }))
  await flush()
  reportUnauthenticated('expired', { endpoint: '/other/whoami' })
  expect([calls, results.map(auth => [auth.whoami.value, auth.reason.value])]).toEqual([
    ['/api/auth/whoami', '/other/whoami', '/other/whoami'], [[identity, null], [identity, 'expired']],
  ])
  probe.resolve(response())
  await flush()
  expect(results.map(auth => [auth.whoami.value, auth.reason.value, auth.error.value])).toEqual([
    [identity, null, null], [identity, null, null],
  ])
})

it.each(['{broken', 'null', '{"reason":"unknown"}', '{"reason":42}'])('handles malformed 401 reason bodies: %s', async body => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 401 })))
  let auth!: UseWhoamiResult
  mount(defineComponent({ setup() { auth = useWhoami(); return () => null } }))
  await flush()
  expect([auth.whoami.value, auth.reason.value, auth.error.value, auth.loading.value]).toEqual([null, null, null, false])
})

it('parses typed 401 reasons and clears them after successful sign out', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/logout')
    ? new Response('{}')
    : new Response('{"reason":"rotated"}', { status: 401 })))
  let auth!: UseWhoamiResult
  mount(defineComponent({ setup() { auth = useWhoami(); return () => null } }))
  await flush()
  expect([auth.whoami.value, auth.reason.value]).toEqual([null, 'rotated'])
  await auth.signOut()
  expect([auth.whoami.value, auth.reason.value, auth.error.value]).toEqual([null, null, null])
})

it('periodically revalidates only when configured and removes timers and reports on disposal', async () => {
  vi.useFakeTimers()
  const fetch = vi.fn(async () => response())
  vi.stubGlobal('fetch', fetch)
  const shown = ref(true)
  const child = defineComponent({ setup() { useWhoami({ revalidateS: 2 }); return () => null } })
  mount(defineComponent({ setup: () => () => shown.value ? h(child) : null }))
  await vi.advanceTimersByTimeAsync(0)
  expect([fetch.mock.calls.length, vi.getTimerCount()]).toEqual([1, 1])
  await vi.advanceTimersByTimeAsync(2000)
  expect(fetch.mock.calls.length).toBe(2)
  shown.value = false
  await nextTick()
  reportUnauthenticated('revoked')
  window.dispatchEvent(new Event('focus'))
  document.dispatchEvent(new Event('visibilitychange'))
  await vi.advanceTimersByTimeAsync(4000)
  expect([fetch.mock.calls.length, vi.getTimerCount()]).toEqual([2, 0])
  mount(defineComponent({ setup() { useWhoami(); return () => null } }))
  await vi.advanceTimersByTimeAsync(6000)
  expect([fetch.mock.calls.length, vi.getTimerCount()]).toEqual([3, 0])
})

it('imports without browser globals and performs no network work', async () => {
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  vi.stubGlobal('window', undefined)
  vi.stubGlobal('document', undefined)
  vi.resetModules()
  const wrapper = await import('../src/vue/index.js')
  expect([typeof wrapper.useWhoami, wrapper.AuthGate.name, await wrapper.exchangeKey(), fetch.mock.calls]).toEqual([
    'function', 'AuthGate', false, [],
  ])
  vi.unstubAllGlobals()
})
