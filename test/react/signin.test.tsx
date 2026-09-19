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
