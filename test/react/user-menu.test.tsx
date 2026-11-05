// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://x.test/" }
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, renderHook, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthClientError, createAuthClient } from '../../src/client/api.js'
import { mountUserMenu } from '../../src/react/mount.js'
import { UserMenu } from '../../src/react/UserMenu.js'
import { useUserMenu, type UserMenuItem } from '../../src/react/useUserMenu.js'
import type { GrantWhoami, SsoWhoami } from '../../src/react/types.js'
import { renderWithQuery, stubFetch } from './helpers.js'

const realFetch = globalThis.fetch
afterEach(() => {
  cleanup()
  globalThis.fetch = realFetch
})

const sso = (o: Partial<SsoWhoami> = {}): SsoWhoami => ({
  kind: 'sso', email: 'ada@x.test', admin: false, scopes: [], subject: { name: 'Ada Lovelace' }, ...o,
})
const guest = (o: Partial<GrantWhoami> = {}): GrantWhoami => ({
  kind: 'grant', id: 'g1', name: 'Board memo', subject: { name: 'Bea Guest' }, email: null, scopes: ['read'], admin: false, expiresAt: null, ...o,
})

const APP_ITEMS: UserMenuItem[] = [
  { key: 'links', label: 'Share links', href: '/admin', when: 'admin' },
  { key: 'drafts', label: 'Your drafts', href: '/drafts', when: 'sso' },
  { key: 'guide', label: 'Guest guide', href: '/guide', when: 'guest' },
  { key: 'help', label: 'Help', href: '/help' },
]

function hook(options: Partial<Parameters<typeof useUserMenu>[0]> & { whoami: Parameters<typeof useUserMenu>[0]['whoami'] }) {
  const logout = vi.fn(async (_input?: { selection?: string | null }) => ({ ok: true }))
  const client = new QueryClient()
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  const { result } = renderHook(() => useUserMenu({ client: { basePath: '/api/auth', logout }, items: APP_ITEMS, ...options }), { wrapper })
  return { result, logout }
}
const keys = (r: { current: { items: readonly { key: string }[] } }) => r.current.items.map(i => i.key)

describe('useUserMenu', () => {
  it('sso: profile, its entries, sign out', () => {
    const { result } = hook({ whoami: sso() })
    expect(keys(result)).toEqual(['profile', 'drafts', 'help', 'sign-out'])
    expect({ kind: result.current.kind, name: result.current.displayName, admin: result.current.isAdmin, retained: result.current.retained }).toEqual({
      kind: 'sso', name: 'Ada Lovelace', admin: false, retained: false,
    })
  })

  it('admin: also the admin entries', () => {
    const { result } = hook({ whoami: sso({ admin: true }) })
    expect(keys(result)).toEqual(['profile', 'links', 'drafts', 'help', 'sign-out'])
    expect(result.current.isAdmin).toBe(true)
  })

  it('guest: no profile, and always a way to sign out', () => {
    const { result } = hook({ whoami: guest() })
    expect(keys(result)).toEqual(['guide', 'help', 'sign-out'])
    expect({ kind: result.current.kind, name: result.current.displayName }).toEqual({ kind: 'guest', name: 'Bea Guest' })
    const anonymous = hook({ whoami: guest({ name: null, subject: null }), items: [] })
    expect(keys(anonymous.result)).toEqual(['sign-out'])
    expect(anonymous.result.current.displayName).toBe(null)
  })

  it('a retained gate gets accounts; a profile-less one no profile; signed out, nothing', () => {
    expect(keys(hook({ whoami: sso({ selection: 'sel' }), items: [] }).result)).toEqual(['profile', 'accounts', 'sign-out'])
    expect(keys(hook({ whoami: sso(), items: [], profile: false }).result)).toEqual(['sign-out'])
    expect(keys(hook({ whoami: null }).result)).toEqual([])
    expect(hook({ whoami: undefined }).result.current.kind).toBe(null)
  })

  it('sign-out sends the selection of the identity shown', async () => {
    const onSignedOut = vi.fn()
    const { result, logout } = hook({ whoami: sso({ selection: 'sel-7' }), onSignedOut })
    await result.current.signOut()
    expect(logout.mock.calls).toEqual([[{ selection: 'sel-7' }]])
    expect(onSignedOut.mock.calls.length).toBe(1)
  })

  it('outside retained mode, no selection is sent', async () => {
    const { result, logout } = hook({ whoami: sso() })
    await result.current.signOut()
    expect(logout.mock.calls).toEqual([[{ selection: null }]])
  })

  it('a stale selection is reported, and does not count as signed out', async () => {
    const onSignedOut = vi.fn()
    const { result, logout } = hook({ whoami: sso({ selection: 'old' }), onSignedOut })
    logout.mockRejectedValueOnce(new AuthClientError(409, { error: 'selection_context_conflict' }))
    await result.current.signOut()
    await waitFor(() => expect(result.current.error?.message).toBe('Your accounts changed in another tab; review and try again.'))
    expect(onSignedOut.mock.calls).toEqual([])
  })

  it('any other failure says so', async () => {
    const { result, logout } = hook({ whoami: sso() })
    logout.mockRejectedValueOnce(new TypeError('network'))
    await result.current.signOut()
    await waitFor(() => expect(result.current.error?.message).toBe('Could not sign out. Please try again.'))
  })

  it('an app\'s profile page replaces the built-in panel', () => {
    const onOpenProfile = vi.fn()
    const { result } = hook({ whoami: sso(), onOpenProfile })
    const profile = result.current.items[0]!
    profile.onClick!({} as never)
    expect(onOpenProfile.mock.calls.length).toBe(1)
    expect(result.current.profileOpen).toBe(false)
  })
})

describe('UserMenu', () => {
  const client = () => createAuthClient()
  const itemNames = () => screen.getAllByRole('menuitem').map(i => i.textContent)

  it('opens from the avatar: who you are, then items in order, sign out last', async () => {
    renderWithQuery(<UserMenu whoami={sso({ admin: true })} client={client()} items={APP_ITEMS} />)
    const user = userEvent.setup()
    expect(screen.queryByRole('dialog')).toBe(null)
    const trigger = screen.getByRole('button', { name: 'Signed in as Ada Lovelace' })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    await user.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('dialog').textContent!.startsWith('ALAda Lovelaceada@x.test')).toBe(true)
    expect(itemNames()).toEqual(['Profile', 'Share links', 'Your drafts', 'Help', 'Sign out'])
    expect(screen.getByRole('menuitem', { name: 'Share links' }).getAttribute('href')).toBe('/admin')
  })

  it('closes on Escape, and moves through items with the arrow keys', async () => {
    renderWithQuery(<UserMenu whoami={sso()} client={client()} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Signed in as Ada Lovelace' }))
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Profile'))
    await user.keyboard('{ArrowDown}')
    expect(document.activeElement?.textContent).toBe('Sign out')
    await user.keyboard('{ArrowDown}')
    expect(document.activeElement?.textContent).toBe('Profile')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBe(null))
  })

  it('a guest is labelled as a share link, with no profile', async () => {
    renderWithQuery(<UserMenu whoami={guest()} client={client()} />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Signed in as Bea Guest' }))
    expect(screen.getByText('share link')).toBeTruthy()
    expect(itemNames()).toEqual(['Sign out'])
  })

  it('an anonymous link still has a face, a label and sign out', async () => {
    renderWithQuery(<UserMenu whoami={guest({ name: null, subject: null })} client={client()} />)
    const trigger = screen.getByRole('button', { name: 'Signed in with a share link' })
    expect(trigger.textContent).toBe('?')
    await userEvent.setup().click(trigger)
    expect(screen.getByText('Anonymous link')).toBeTruthy()
    expect(itemNames()).toEqual(['Sign out'])
  })

  it('Profile opens the panel in place, against this client\'s routes', async () => {
    renderWithQuery(<UserMenu whoami={sso()} client={createAuthClient({ basePath: '/api/view' })} />)
    const user = userEvent.setup()
    const calls = stubFetch({ '/api/view/profile': { status: 200, body: { ok: true } } })
    await user.click(screen.getByRole('button', { name: 'Signed in as Ada Lovelace' }))
    await user.click(screen.getByRole('menuitem', { name: 'Profile' }))
    expect((screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value).toBe('Ada Lovelace')
    await user.click(screen.getByRole('button', { name: 'Save profile' }))
    await waitFor(() => expect(calls.map(c => `${c.method} ${c.url}`)).toEqual(['PUT /api/view/profile']))
    await screen.findByRole('menuitem', { name: 'Profile' })
  })

  it('a retained gate shows its accounts once, with one sign-out control for the active account', async () => {
    stubFetch({
      '/api/auth/accounts': {
        status: 200,
        body: {
          selection: 'sel',
          active: 'a',
          incoming: [],
          accounts: [
            { id: 'a', kind: 'sso', email: 'ada@x.test', name: null, subject: null, active: true, expiresAt: 2e9 },
            { id: 'b', kind: 'grant', email: null, name: 'Memo', subject: null, active: false, expiresAt: 2e9 },
          ],
        },
      },
    })
    renderWithQuery(<UserMenu whoami={sso({ selection: 'sel' })} client={client()} />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Signed in as Ada Lovelace' }))
    await screen.findByRole('group', { name: 'Accounts' })
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBe(null)
    expect(screen.getAllByRole('menuitem').map(i => i.textContent)).toEqual(['Profile', 'Sign out'])
    expect(screen.getByRole('button', { name: 'Sign out of all accounts' })).toBeTruthy()
  })

  it('takes the app\'s name, face and own content, as disky\'s registry and Display submenu need', async () => {
    renderWithQuery(
      <UserMenu
        whoami={sso()}
        client={client()}
        identity={{ name: 'ryan', avatar: 'https://github.com/ryan.png' }}
        items={[{ key: 'display', label: 'Display', content: <div data-testid="display">units</div> }]}
      />,
    )
    const trigger = screen.getByRole('button', { name: 'Signed in as ryan' })
    expect(trigger.querySelector('img')!.getAttribute('src')).toBe('https://github.com/ryan.png')
    await userEvent.setup().click(trigger)
    expect(screen.getByTestId('display').textContent).toBe('units')
    expect(screen.getAllByRole('menuitem').map(i => i.textContent)).toEqual(['Profile', 'Sign out'])
  })

  it('signed out: whatever the app passes, and nothing while loading', () => {
    const { rerender } = renderWithQuery(<UserMenu whoami={undefined} client={client()} signedOut={<a href="/signin">Sign in</a>} />)
    expect(screen.queryByRole('link', { name: 'Sign in' })).toBe(null)
    rerender(<UserMenu whoami={null} client={client()} signedOut={<a href="/signin">Sign in</a>} />)
    expect(screen.getByRole('link', { name: 'Sign in' })).toBeTruthy()
  })
})

describe('mountUserMenu', () => {
  it('hosts the menu in a plain element, fetching its own identity; update and unmount work', async () => {
    const calls = stubFetch({ '/api/view/whoami': { status: 200, body: sso() } })
    const element = document.body.appendChild(document.createElement('div'))
    const mounted = mountUserMenu(element, { basePath: '/api/view', items: [APP_ITEMS[3]!] })
    const trigger = await screen.findByRole('button', { name: 'Signed in as Ada Lovelace' })
    expect(calls.map(c => c.url)).toEqual(['/api/view/whoami'])
    await userEvent.setup().click(trigger)
    expect(screen.getAllByRole('menuitem').map(i => i.textContent)).toEqual(['Profile', 'Help', 'Sign out'])
    mounted.update({ items: [] })
    await waitFor(() => expect(screen.getAllByRole('menuitem').map(i => i.textContent)).toEqual(['Profile', 'Sign out']))
    mounted.unmount()
    await waitFor(() => expect(element.childElementCount).toBe(0))
    element.remove()
  })
})
