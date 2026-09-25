// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://x.test/" }
import { cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EmailCodeForm } from '../../src/react/EmailCodeForm.js'
import { GoogleOneTap } from '../../src/react/GoogleOneTap.js'
import { SignInPanel } from '../../src/react/SignInPanel.js'
import { renderWithQuery, setLocation, stubFetch } from './helpers.js'

const realFetch = globalThis.fetch

beforeEach(() => setLocation('https://x.test/dash'))
afterEach(() => {
  cleanup()
  globalThis.fetch = realFetch
})

describe('SignInPanel — Google-first', () => {
  it('renders "Continue with Google" pointing at the start URL with the current path as next', () => {
    setLocation('https://x.test/finances/2025?q=1')
    renderWithQuery(<SignInPanel googleUrl="/auth/google" />)
    expect(screen.getByRole('link', { name: 'Continue with Google' }).getAttribute('href')).toBe(
      '/auth/google?next=%2Ffinances%2F2025%3Fq%3D1',
    )
  })

  it('pre-fills a denied Google address into both the code form and request-access', () => {
    setLocation('https://x.test/?denied=bob%40x.test')
    renderWithQuery(<SignInPanel googleUrl="/auth/google" emailAuth requestAccess />)
    // One value, two inputs (email-code + request-access) — the verified address
    // flows into whichever path the visitor takes next.
    expect(screen.getAllByDisplayValue('bob@x.test')).toHaveLength(2)
  })
})

describe('SignInPanel — oneTap', () => {
  const ONE_TAP = { clientId: 'client-123', nonceEndpoint: '/n', verifyEndpoint: '/v' }

  afterEach(() => {
    document.head.querySelector('script[src="https://accounts.google.com/gsi/client"]')?.remove()
    delete (window as { google?: unknown }).google
  })

  it("shows Google's rendered button and no redirect button beside it", async () => {
    stubFetch({ '/n': { status: 200, body: { nonce: 'n1' } } })
    const script = document.createElement('script')
    script.src = 'https://accounts.google.com/gsi/client'
    script.dataset.loaded = 'true'
    document.head.appendChild(script)
    const renderButton = (parent: HTMLElement) => {
      const b = document.createElement('button')
      b.textContent = 'Sign in with Google (GSI)'
      parent.appendChild(b)
    }
    ;(window as { google?: unknown }).google = { accounts: { id: { initialize: () => {}, renderButton } } }

    renderWithQuery(<SignInPanel googleUrl="/auth/google" oneTap={ONE_TAP} />)
    await waitFor(() => expect(screen.getByRole('button').textContent).toBe('Sign in with Google (GSI)'))
    expect(screen.queryAllByRole('link')).toEqual([])
  })

  it('falls back to the redirect button when GSI cannot load', async () => {
    stubFetch({ '/n': { status: 200, body: {} } })
    renderWithQuery(<SignInPanel googleUrl="/auth/google" oneTap={ONE_TAP} />)
    await waitFor(() =>
      expect(screen.getAllByRole('link').map(a => a.getAttribute('href'))).toEqual(['/auth/google?next=%2Fdash']),
    )
  })
})

describe('EmailCodeForm', () => {
  it('advances from email to code entry, then signs in on a good code', async () => {
    const calls = stubFetch({
      '/api/auth/email/start': { status: 200, body: { status: 'sent', id: 'pid-1' } },
      '/api/auth/email/code': { status: 200, body: { ok: true } },
    })
    const onSignedIn = vi.fn()
    renderWithQuery(<EmailCodeForm onSignedIn={onSignedIn} />)

    await userEvent.type(screen.getByLabelText('Email'), 'user@openathena.ai')
    await userEvent.click(screen.getByRole('button', { name: 'Email me a code' }))

    // The code step appears only after start succeeds.
    const codeField = await screen.findByLabelText('Code')
    await userEvent.type(codeField, '123456')
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))

    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1))
    expect(calls.map(c => [c.url, c.body])).toEqual([
      ['/api/auth/email/start', { email: 'user@openathena.ai' }],
      ['/api/auth/email/code', { id: 'pid-1', code: '123456' }],
    ])
  })

  it('stays on the code step when the code is wrong', async () => {
    stubFetch({
      '/api/auth/email/start': { status: 200, body: { status: 'sent', id: 'pid-2' } },
      '/api/auth/email/code': { status: 400, body: { ok: false } },
    })
    const onSignedIn = vi.fn()
    renderWithQuery(<EmailCodeForm onSignedIn={onSignedIn} />)
    await userEvent.type(screen.getByLabelText('Email'), 'user@openathena.ai')
    await userEvent.click(screen.getByRole('button', { name: 'Email me a code' }))
    await userEvent.type(await screen.findByLabelText('Code'), '000000')
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(screen.getByLabelText('Code')).toBeDefined())
    expect(onSignedIn).not.toHaveBeenCalled()
  })
})

describe('GoogleOneTap', () => {
  /** A loaded GSI stub that records what the component asked of it. */
  function stubGsi() {
    const calls: { initialize: Record<string, unknown>[]; prompt: number; cancel: number } = { initialize: [], prompt: 0, cancel: 0 }
    const script = document.createElement('script')
    script.src = 'https://accounts.google.com/gsi/client'
    script.dataset.loaded = 'true'
    document.head.appendChild(script)
    ;(window as { google?: unknown }).google = {
      accounts: {
        id: {
          initialize: (c: Record<string, unknown>) => calls.initialize.push(c),
          renderButton: (parent: HTMLElement) => parent.appendChild(document.createElement('button')),
          prompt: () => calls.prompt++,
          cancel: () => calls.cancel++,
        },
      },
    }
    return calls
  }
  const withoutCallback = ({ callback: _, ...rest }: Record<string, unknown>) => rest

  afterEach(() => {
    document.head.querySelector('script[src="https://accounts.google.com/gsi/client"]')?.remove()
    delete (window as { google?: unknown }).google
  })

  it('is button-only by default, with FedCM for both flows and no auto-select', async () => {
    stubFetch({ '/api/auth/google/onetap/nonce': { status: 200, body: { nonce: 'n1' } } })
    const calls = stubGsi()
    renderWithQuery(<GoogleOneTap clientId="client-123" />)
    await waitFor(() => expect(screen.getAllByRole('button')).toHaveLength(1))
    expect([calls.initialize.map(withoutCallback), calls.prompt]).toEqual([
      [{ client_id: 'client-123', nonce: 'n1', use_fedcm_for_prompt: true, use_fedcm_for_button: true, auto_select: false }],
      0,
    ])
  })

  it('surfaces the prompt when asked, auto-selecting only with autoSelect, and cancels it on unmount', async () => {
    stubFetch({ '/api/auth/google/onetap/nonce': { status: 200, body: { nonce: 'n1' } } })
    const calls = stubGsi()
    const { unmount } = renderWithQuery(<GoogleOneTap clientId="client-123" prompt={{ autoSelect: true }} />)
    await waitFor(() => expect(calls.prompt).toBe(1))
    expect(calls.initialize.map(c => c.auto_select)).toEqual([true])
    unmount()
    expect(calls.cancel).toBe(1)
  })

  it('prompt: true surfaces the toast without auto-select', async () => {
    stubFetch({ '/api/auth/google/onetap/nonce': { status: 200, body: { nonce: 'n1' } } })
    const calls = stubGsi()
    renderWithQuery(<GoogleOneTap clientId="client-123" prompt />)
    await waitFor(() => expect(calls.prompt).toBe(1))
    expect(calls.initialize.map(c => c.auto_select)).toEqual([false])
  })

  it('renders the fallback when GSI cannot initialize', async () => {
    // No nonce comes back → init throws → the redirect button (fallback) shows,
    // so the page always has a working sign-in.
    stubFetch({ '/api/auth/google/onetap/nonce': { status: 200, body: {} } })
    renderWithQuery(
      <GoogleOneTap clientId="client-123" fallback={<a href="/auth/google">Continue with Google</a>} />,
    )
    await waitFor(() => expect(screen.getByRole('link', { name: 'Continue with Google' })).toBeDefined())
  })
})
