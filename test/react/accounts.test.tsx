// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://x.test/" }
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import type { AccountView, AccountsResponse } from '../../src/core/http.js'
import { AccountSwitcher } from '../../src/react/Accounts.js'
import { renderWithQuery } from './helpers.js'

const realFetch = globalThis.fetch
afterEach(() => {
  cleanup()
  globalThis.fetch = realFetch
})

const acct = (id: string, o: Partial<AccountView> = {}): AccountView => ({
  id,
  kind: 'sso',
  email: `${id}@x.test`,
  name: null,
  subject: null,
  active: false,
  expiresAt: 2_000_000_000,
  ...o,
})
const page = (accounts: AccountView[], o: Partial<AccountsResponse> = {}): AccountsResponse => ({
  selection: 'sel-1',
  active: accounts.find(a => a.active)?.id ?? null,
  accounts,
  incoming: [],
  ...o,
})

/** Scripted routes (a function of the request body), recording each call with its selection header. */
function stub(routes: Record<string, (body: unknown) => { status: number; body: unknown }>) {
  const calls: { path: string; method: string; selection: string | null; body: unknown }[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
    const headers = new Headers(init?.headers)
    const body = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ path, method: init?.method ?? 'GET', selection: headers.get('X-OA-Selection-Context'), body })
    const r = routes[path]?.(body) ?? { status: 500, body: null }
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return calls
}

const names = () => screen.getAllByRole('listitem').map(li => li.textContent)

describe('AccountSwitcher', () => {
  it('lists accounts, tags a share link as one, and switches with the selection it last saw', async () => {
    const bea = { kind: 'grant', email: null, name: 'Board', subject: { name: 'Bea' } } as const
    let current = page([acct('ann', { active: true }), acct('g1', bea)])
    const calls = stub({
      '/api/auth/accounts': () => ({ status: 200, body: current }),
      '/api/auth/accounts/select': () => {
        current = page([acct('ann'), acct('g1', { ...bea, active: true })], { selection: 'sel-2' })
        return { status: 200, body: current }
      },
    })
    renderWithQuery(<AccountSwitcher addAccountHref="/signin" />)
    await screen.findByText('Bea')
    expect(names()).toEqual(['Aann@x.testverifiedcurrent×', 'BBeashare link×'])
    await userEvent.click(within(screen.getAllByRole('listitem')[1]!).getAllByRole('button')[0]!)
    await waitFor(() => expect(screen.getAllByRole('listitem')[1]!.textContent).toBe('BBeashare linkcurrent×'))
    expect(calls.filter(c => c.method === 'POST')).toEqual([
      { path: '/api/auth/accounts/select', method: 'POST', selection: 'sel-1', body: { id: 'g1' } },
    ])
    expect(screen.getAllByRole('link').map(a => [a.textContent, a.getAttribute('href')])).toEqual([['Add another account', '/signin']])
  })

  it('a stale selection says so and re-reads the list instead of acting as someone else', async () => {
    let version = 1
    const calls = stub({
      '/api/auth/accounts': () => ({ status: 200, body: page([acct('ann', { active: true }), acct('bob')], { selection: `sel-${version}` }) }),
      '/api/auth/accounts/remove': () => ({
        status: 409,
        body: { error: 'selection_context_conflict', recoverable: true, action: 'refresh_selection' },
      }),
    })
    renderWithQuery(<AccountSwitcher />)
    await screen.findByText('bob@x.test')
    version = 2
    await userEvent.click(screen.getByRole('button', { name: 'Remove bob@x.test' }))
    await screen.findByRole('alert')
    expect(screen.getByRole('alert').textContent).toBe('Your accounts changed in another tab; review and try again.')
    await waitFor(() => expect(calls.filter(c => c.path === '/api/auth/accounts').length).toBe(2))
    expect(calls.filter(c => c.method === 'POST')).toEqual([
      { path: '/api/auth/accounts/remove', method: 'POST', selection: 'sel-1', body: { id: 'bob' } },
    ])
  })

  it('one account and nothing waiting: just that account and sign out, no switching controls', async () => {
    stub({ '/api/auth/accounts': () => ({ status: 200, body: page([acct('ann', { active: true })]) }) })
    renderWithQuery(<AccountSwitcher />)
    await screen.findByText('ann@x.test')
    expect(screen.getAllByRole('button').map(b => b.textContent)).toEqual(['Aann@x.testverified', 'Sign out'])
  })

  it('an incoming link is offered, and taking it posts its id', async () => {
    const calls = stub({
      '/api/auth/accounts': () => ({
        status: 200,
        body: page([acct('ann', { active: true })], {
          incoming: [{ id: 'p1', name: 'Board', email: null, subject: { name: 'Bea' }, expiresAt: 2_000_000_000 }],
        }),
      }),
      '/api/auth/accounts/incoming': () => ({ status: 200, body: page([acct('ann'), acct('g1', { kind: 'grant', active: true })]) }),
    })
    renderWithQuery(<AccountSwitcher />)
    await userEvent.click(await screen.findByRole('button', { name: 'Use it' }))
    await waitFor(() => expect(calls.filter(c => c.method === 'POST').map(c => [c.path, c.selection, c.body])).toEqual([
      ['/api/auth/accounts/incoming', 'sel-1', { id: 'p1' }],
    ]))
  })

  it('renders nothing when the browser holds no accounts', async () => {
    const calls = stub({ '/api/auth/accounts': () => ({ status: 404, body: { error: 'no accounts in this browser' } }) })
    const { container } = renderWithQuery(<AccountSwitcher />)
    await waitFor(() => expect(calls.length).toBe(1))
    expect(container.innerHTML).toBe('')
  })
})
