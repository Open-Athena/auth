// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { reportUnauthenticated } from '../../src/client/auth-events.js'
import { sessionLossMessage, type SessionLossReason } from '../../src/core/denial.js'
import { AuthGate } from '../../src/react/AuthGate.js'
import { SignInPanel } from '../../src/react/SignInPanel.js'
import { useKeyExchange } from '../../src/react/exchange.js'
import { useForgetWhoami, useWhoami } from '../../src/react/useWhoami.js'
import { renderWithQuery, setLocation } from './helpers.js'

const originalFetch = globalThis.fetch
const identity = { kind: 'sso', email: 'a@example.test', admin: false, scopes: [], subject: null }
afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
  vi.useRealTimers()
  vi.restoreAllMocks()
  setLocation('/')
})

it('discards a sibling anonymous probe that finishes after key redemption', async () => {
  setLocation('/?key=SECRET')
  const calls: string[] = []
  let finishAnonymous!: (response: Response) => void
  let finishExchange!: (response: Response) => void
  let anonymousSignal!: AbortSignal
  globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const endpoint = String(input)
    calls.push(endpoint)
    if (endpoint === '/api/auth/exchange') return new Promise<Response>(resolve => { finishExchange = resolve })
    if (calls.filter(url => url === '/custom/whoami').length === 1) {
      anonymousSignal = init!.signal as AbortSignal
      return new Promise<Response>(resolve => { finishAnonymous = resolve })
    }
    return Promise.resolve(new Response(JSON.stringify(identity), { status: 200 }))
  }) as typeof fetch
  function NavChip() {
    const { whoami } = useWhoami({ endpoint: '/custom/whoami' })
    return <output>{whoami?.kind ?? 'anonymous'}</output>
  }
  const view = renderWithQuery(<><NavChip /><AuthGate source={{ endpoint: '/custom/whoami' }} loading={<p>LOADING</p>} signIn={<p>WALL</p>}><p>APP</p></AuthGate></>)
  expect(calls).toEqual(['/custom/whoami', '/api/auth/exchange'])
  await act(async () => finishExchange(new Response('{}', { status: 200 })))
  await act(async () => finishAnonymous(new Response(JSON.stringify({ error: 'unauthenticated', reason: 'invalid' }), { status: 401 })))
  await waitFor(() => expect(screen.getByText('APP').textContent).toBe('APP'))
  expect(anonymousSignal.aborted).toBe(true)
  expect(screen.getByRole('status').textContent).toBe('sso')
  expect(screen.queryByText('WALL')).toBe(null)
  expect(view.client.getQueryData(['oa-auth', 'whoami', '/custom/whoami'])).toEqual(identity)
  expect(calls).toEqual(['/custom/whoami', '/api/auth/exchange', '/custom/whoami'])
})

it('awaits exchange completion without requiring a QueryClient provider', async () => {
  setLocation('/?key=SECRET')
  globalThis.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as typeof fetch
  let finishCompletion!: () => void
  const completion = new Promise<void>(resolve => { finishCompletion = resolve })
  const onComplete = vi.fn((_exchanged: boolean) => completion)
  function Standalone() {
    const ready = useKeyExchange({}, onComplete)
    return <output>{ready ? 'ready' : 'exchanging'}</output>
  }
  render(<Standalone />)
  await act(async () => {})
  expect(onComplete.mock.calls).toEqual([[true]])
  expect(screen.getByRole('status').textContent).toBe('exchanging')
  await act(async () => finishCompletion())
  expect(screen.getByRole('status').textContent).toBe('ready')
  expect(vi.mocked(globalThis.fetch).mock.calls.map(([url]) => url)).toEqual(['/api/auth/exchange'])
})

it('keeps standalone exchange provider-free without a completion callback', async () => {
  setLocation('/?key=SECRET')
  globalThis.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as typeof fetch
  function Standalone() {
    const ready = useKeyExchange()
    return <output>{ready ? 'ready' : 'exchanging'}</output>
  }
  render(<Standalone />)
  await act(async () => {})
  expect(screen.getByRole('status').textContent).toBe('ready')
  expect(vi.mocked(globalThis.fetch).mock.calls.map(([url]) => url)).toEqual(['/api/auth/exchange'])
})

function server() {
  const state: { live: boolean; reason?: SessionLossReason } = { live: true }
  const calls: string[] = []
  globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
    calls.push(String(url))
    return new Response(JSON.stringify(state.live ? identity : { error: 'unauthenticated', reason: state.reason }), {
      status: state.live ? 200 : 401,
    })
  }) as typeof fetch
  return { state, calls }
}

it('shares one report revalidation between the nav and gate observers', async () => {
  const { state, calls } = server()
  function NavChip() {
    const { whoami, reason } = useWhoami()
    return <output>{JSON.stringify({ live: Boolean(whoami), reason })}</output>
  }
  const view = renderWithQuery(<><NavChip /><AuthGate exchange={false} signIn={<SignInPanel />}><p>APP</p></AuthGate></>)
  view.client.setQueryDefaults(['private'], { gcTime: Infinity })
  view.client.setQueryData(['private', 'report'], { rows: [1, 2] })
  await waitFor(() => expect(screen.getByText('APP').textContent).toBe('APP'))
  expect(calls).toEqual(['/api/auth/whoami'])
  state.live = false
  act(() => reportUnauthenticated('revoked'))
  await waitFor(() => expect(screen.getAllByRole('status').map(node => node.textContent)).toEqual([
    '{"live":false,"reason":"revoked"}',
    'This link was revoked.',
  ]))
  expect(calls).toEqual(['/api/auth/whoami', '/api/auth/whoami'])
  expect(view.client.getQueryData(['private', 'report'])).toEqual({ rows: [1, 2] })

  view.rerender(<><NavChip /></>)
  state.live = true
  act(() => reportUnauthenticated('invalid'))
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('{"live":true,"reason":null}'))
  expect(calls).toEqual(['/api/auth/whoami', '/api/auth/whoami', '/api/auth/whoami'])
  view.unmount()
  act(() => reportUnauthenticated('expired'))
  expect(calls).toEqual(['/api/auth/whoami', '/api/auth/whoami', '/api/auth/whoami'])
})

it('revalidates each QueryClient independently for the same endpoint', async () => {
  const { state, calls } = server()
  renderWithQuery(<AuthGate exchange={false} signIn={<p>FIRST WALL</p>}><p>FIRST APP</p></AuthGate>)
  renderWithQuery(<AuthGate exchange={false} signIn={<p>SECOND WALL</p>}><p>SECOND APP</p></AuthGate>)
  await waitFor(() => expect(screen.getByText('SECOND APP').textContent).toBe('SECOND APP'))
  expect(calls).toEqual(['/api/auth/whoami', '/api/auth/whoami'])
  state.live = false
  act(() => reportUnauthenticated('expired'))
  await waitFor(() => expect([
    screen.getByText('FIRST WALL').textContent,
    screen.getByText('SECOND WALL').textContent,
  ]).toEqual(['FIRST WALL', 'SECOND WALL']))
  expect(calls).toEqual(['/api/auth/whoami', '/api/auth/whoami', '/api/auth/whoami', '/api/auth/whoami'])
})

it('refetches a report, retains its reason after cookie clearing, and clears it after sign-in and logout', async () => {
  const { state, calls } = server()
  function Probe() {
    const { whoami, reason, refresh } = useWhoami()
    const forget = useForgetWhoami()
    return <><output>{JSON.stringify({ live: Boolean(whoami), reason })}</output><button onClick={refresh}>Refresh</button><button onClick={forget}>Logout</button></>
  }
  renderWithQuery(<Probe />)
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('{"live":true,"reason":null}'))
  state.live = false
  act(() => reportUnauthenticated('revoked'))
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('{"live":false,"reason":"revoked"}'))
  expect(calls).toEqual(['/api/auth/whoami', '/api/auth/whoami'])
  state.live = true
  act(() => screen.getByText('Refresh').click())
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('{"live":true,"reason":null}'))
  state.live = false
  act(() => screen.getByText('Logout').click())
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('{"live":false,"reason":null}'))
})

it.each<[SessionLossReason, string]>([
  ['revoked', 'This link was revoked.'],
  ['expired', 'This session or link expired.'],
  ['rotated', 'This link was replaced; ask for the new one.'],
  ['delisted', 'This account no longer has access.'],
  ['invalid', 'This sign-in is no longer valid. Please sign in again.'],
])('shows the %s wall with request access and the callback reason', async (reason, message) => {
  const { state, calls } = server()
  const wall = vi.fn((_refresh: () => void, _reason: SessionLossReason | null) => <div><SignInPanel requestAccess /></div>)
  renderWithQuery(<AuthGate exchange={false} signIn={wall}>APP</AuthGate>)
  await waitFor(() => expect(screen.getByText('APP').textContent).toBe('APP'))
  state.live = false
  act(() => reportUnauthenticated(reason))
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe(message))
  expect(wall.mock.lastCall?.[1]).toBe(reason)
  expect(screen.getByRole('button', { name: 'Request access' }).textContent).toBe('Request access')
  expect(calls).toEqual(['/api/auth/whoami', '/api/auth/whoami'])
})

it('scopes reports and does not log out a confirmed live cookie', async () => {
  const { calls } = server()
  renderWithQuery(<><AuthGate exchange={false} signIn="WALL"><p>APP</p></AuthGate><AuthGate exchange={false} source={{ endpoint: '/other/whoami' }} signIn="OTHER WALL"><p>OTHER APP</p></AuthGate></>)
  await waitFor(() => expect(screen.getByText('OTHER APP').textContent).toBe('OTHER APP'))
  act(() => reportUnauthenticated('invalid', { endpoint: '/other/whoami' }))
  await waitFor(() => expect(calls).toEqual(['/api/auth/whoami', '/other/whoami', '/other/whoami']))
  expect(screen.queryByText('WALL')).toBe(null)
  expect(screen.queryByText('OTHER WALL')).toBe(null)
})

it('revalidates on visible transitions and cleans up reports, visibility, and timers', async () => {
  const { calls } = server()
  const interval = vi.spyOn(globalThis, 'setInterval')
  const clear = vi.spyOn(globalThis, 'clearInterval')
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  const view = renderWithQuery(<AuthGate exchange={false} revalidateS={10} signIn="WALL">APP</AuthGate>)
  await waitFor(() => expect(screen.getByText('APP').textContent).toBe('APP'))
  act(() => document.dispatchEvent(new Event('visibilitychange')))
  await waitFor(() => expect(calls.length).toBe(2))
  const timerIndex = interval.mock.calls.findIndex(call => call[1] === 10_000)
  expect(timerIndex >= 0).toBe(true)
  const tick = interval.mock.calls[timerIndex]![0] as () => void
  act(() => tick())
  await waitFor(() => expect(calls.length).toBe(3))
  clear.mockClear()
  view.unmount()
  expect(clear.mock.calls).toEqual([[interval.mock.results[timerIndex]!.value]])
  calls.length = 0
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'))
    reportUnauthenticated('expired')
  })
  expect(calls).toEqual([])
})

it('does not install a periodic timer by default', async () => {
  server()
  const interval = vi.spyOn(globalThis, 'setInterval')
  renderWithQuery(<AuthGate exchange={false} signIn="WALL">APP</AuthGate>)
  await waitFor(() => expect(screen.getByText('APP').textContent).toBe('APP'))
  // Testing Library owns its 50ms polling timer; the hook must add none.
  expect(interval.mock.calls.map(call => call[1])).toEqual([50])
})

it('aborts an obsolete probe when a report arrives', async () => {
  const signals: AbortSignal[] = []
  globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    signals.push(init!.signal as AbortSignal)
    if (signals.length === 1) return new Promise<Response>(() => {})
    return new Response(JSON.stringify({ reason: 'rotated' }), { status: 401 })
  }) as typeof fetch
  renderWithQuery(<AuthGate exchange={false} signIn={<SignInPanel />}>APP</AuthGate>)
  await waitFor(() => expect(signals.length).toBe(1))
  act(() => reportUnauthenticated('revoked'))
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe(sessionLossMessage('rotated')))
  expect(signals.map(signal => signal.aborted)).toEqual([true, false])
})

it('supports explicit reason and message overrides', () => {
  renderWithQuery(<SignInPanel reason="expired" reasonMessage={reason => `Lost: ${reason}`} />)
  expect(screen.getByRole('status').textContent).toBe('Lost: expired')
})
