// @vitest-environment jsdom
// jsdom defaults to localhost, and `history.replaceState` to another origin is a
// SecurityError — so pin the origin the URL-stripping assertions are written against.
// @vitest-environment-options { "url": "https://x.test/" }
import { cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AuthGate } from '../../src/react/AuthGate.js'
import { AccessNotice } from '../../src/react/disclosure.js'
import { exchangeKeyParam } from '../../src/react/exchange.js'
import { RequestAccessForm } from '../../src/react/RequestAccessForm.js'
import { SignInPanel } from '../../src/react/SignInPanel.js'
import { WhoamiChip } from '../../src/react/WhoamiChip.js'
import { displayName, hasScope, type AppWhoami } from '../../src/react/types.js'
import { renderWithQuery, setLocation, stubFetch } from './helpers.js'

const realFetch = globalThis.fetch

const SSO: AppWhoami = { kind: 'sso', email: 'staff@openathena.ai', admin: false, scopes: ['internal'] }
const GRANT: AppWhoami = {
  kind: 'grant',
  name: 'Bob Smith',
  subject: null,
  email: 'bob@example.com',
  scopes: ['reports'],
  admin: false,
  expiresAt: null,
}

beforeEach(() => setLocation('https://x.test/dash'))
afterEach(() => {
  // Explicit imports (rather than vitest globals) mean RTL's auto-cleanup is
  // never registered; without this, a previous test's DOM satisfies the next
  // test's `waitFor` and the suite passes for the wrong reason.
  cleanup()
  globalThis.fetch = realFetch
})

describe('displayName', () => {
  it('prefers the grant name, then a subject, then the email', () => {
    const subjectOnly = { ...GRANT, name: null, subject: { first: 'Bob', last: 'Smith' } }
    const emailOnly = { ...GRANT, name: null, subject: null }
    expect([
      displayName(GRANT),
      displayName(subjectOnly),
      displayName(emailOnly),
      displayName(SSO),
      displayName({ name: 'Edge User', email: 'e@x.test' }),
      displayName({ email: 'e@x.test' }),
      displayName(null),
      displayName(undefined),
    ]).toEqual(['Bob Smith', 'Bob Smith', 'bob@example.com', 'staff@openathena.ai', 'Edge User', 'e@x.test', null, null])
  })
})

describe('hasScope', () => {
  it('matches exactly, honours the wildcard, and is false for edge identities', () => {
    expect([
      hasScope(GRANT, 'reports'),
      hasScope(GRANT, 'finances'),
      hasScope({ ...SSO, scopes: ['*'] }, 'anything'),
      hasScope({ email: 'e@x.test' }, 'reports'),
      hasScope(null, 'reports'),
    ]).toEqual([true, false, true, false, false])
  })
})

describe('exchangeKeyParam', () => {
  it('posts the token and strips it from the URL', async () => {
    setLocation('https://x.test/dash?key=SECRET&tab=2')
    const calls = stubFetch({ '/api/auth/exchange': { status: 200, body: GRANT } })
    expect(await exchangeKeyParam()).toBe(true)
    expect(calls).toEqual([{ url: '/api/auth/exchange', method: 'POST', body: { token: 'SECRET' } }])
    expect(window.location.href).toBe('https://x.test/dash?tab=2')
  })

  it('strips the token even when the exchange fails — it must not survive in history', async () => {
    setLocation('https://x.test/dash?key=REVOKED')
    stubFetch({ '/api/auth/exchange': { status: 401, body: { error: 'invalid link' } } })
    expect(await exchangeKeyParam()).toBe(false)
    expect(window.location.href).toBe('https://x.test/dash')
  })

  it('strips the token even when the network throws', async () => {
    setLocation('https://x.test/dash?key=SECRET')
    globalThis.fetch = (() => Promise.reject(new Error('offline'))) as typeof fetch
    expect(await exchangeKeyParam()).toBe(false)
    expect(window.location.href).toBe('https://x.test/dash')
  })

  it('does nothing when no token is present', async () => {
    const calls = stubFetch({})
    expect(await exchangeKeyParam()).toBe(false)
    expect(calls).toEqual([])
    expect(window.location.href).toBe('https://x.test/dash')
  })

  it('spends one redemption when called twice concurrently', async () => {
    // React StrictMode double-invokes effects, and any remount re-runs them.
    // Claiming the token synchronously is what stops the second call finding
    // one — a second POST would burn a `maxRedeems: 1` link and inflate the
    // redemption count the admin view reads as a forwarding signal.
    setLocation('https://x.test/dash?key=SECRET')
    const calls = stubFetch({ '/api/auth/exchange': { status: 200, body: GRANT } })
    const [a, b] = await Promise.all([exchangeKeyParam(), exchangeKeyParam()])
    expect([a, b]).toEqual([true, false])
    expect(calls.length).toBe(1)
  })

  it('honours a custom param name', async () => {
    setLocation('https://x.test/dash?t=SECRET&key=untouched')
    const calls = stubFetch({ '/api/auth/exchange': { status: 200, body: GRANT } })
    await exchangeKeyParam({ param: 't' })
    expect(calls[0]!.body).toEqual({ token: 'SECRET' })
    expect(window.location.href).toBe('https://x.test/dash?key=untouched')
  })
})

describe('AuthGate', () => {
  const gate = (props: Partial<Parameters<typeof AuthGate>[0]> = {}) =>
    renderWithQuery(
      <AuthGate
        source={{ kind: 'app' }}
        signIn={<div>WALL</div>}
        loading={<div>LOADING</div>}
        {...props}
      >
        {w => <div>APP:{displayName(w)}</div>}
      </AuthGate>,
    )

  it('shows the app for an authenticated identity', async () => {
    stubFetch({ '/api/auth/whoami': { status: 200, body: GRANT } })
    gate()
    expect(screen.getByText('LOADING')).toBeDefined()
    await waitFor(() => expect(screen.getByText('APP:Bob Smith')).toBeDefined())
  })

  it('shows the wall on a 401 rather than retrying it', async () => {
    const calls = stubFetch({ '/api/auth/whoami': { status: 401, body: { error: 'unauthenticated' } } })
    gate()
    await waitFor(() => expect(screen.getByText('WALL')).toBeDefined())
    expect(calls.length).toBe(1)
  })

  it('redeems a `?key=` link before probing, so the wall never flashes', async () => {
    setLocation('https://x.test/dash?key=SECRET')
    const calls = stubFetch({
      '/api/auth/exchange': { status: 200, body: GRANT },
      '/api/auth/whoami': { status: 200, body: GRANT },
    })
    gate()
    await waitFor(() => expect(screen.getByText('APP:Bob Smith')).toBeDefined())
    expect(calls.map(c => [c.method, c.url])).toEqual([
      ['POST', '/api/auth/exchange'],
      ['GET', '/api/auth/whoami'],
    ])
    expect(screen.queryByText('WALL')).toBe(null)
  })

  it('uses the edge endpoint for Tier 1', async () => {
    const calls = stubFetch({ '/cdn-cgi/access/get-identity': { status: 200, body: { email: 'e@x.test' } } })
    renderWithQuery(
      <AuthGate source={{ kind: 'edge' }} signIn={<div>WALL</div>}>
        {w => <div>APP:{displayName(w)}</div>}
      </AuthGate>,
    )
    await waitFor(() => expect(screen.getByText('APP:e@x.test')).toBeDefined())
    expect(calls.map(c => c.url)).toEqual(['/cdn-cgi/access/get-identity'])
  })
})

describe('SignInPanel', () => {
  it('appends the current path so SSO returns you where you started', () => {
    setLocation('https://x.test/finances/2025?q=1')
    renderWithQuery(<SignInPanel signInUrl="/auth/sso" />)
    expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe(
      '/auth/sso?next=%2Ffinances%2F2025%3Fq%3D1',
    )
  })

  it('omits the SSO link when no url is given', () => {
    renderWithQuery(<SignInPanel requestAccess />)
    expect(screen.queryByRole('link')).toBe(null)
    expect(screen.getByRole('button', { name: 'Request access' })).toBeDefined()
  })
})

describe('RequestAccessForm', () => {
  it('submits the fields and reports the pending state', async () => {
    const calls = stubFetch({ '/api/auth/request': { status: 200, body: { status: 'pending' } } })
    renderWithQuery(<RequestAccessForm />)
    await userEvent.type(screen.getByLabelText('Email'), 'bob@example.com')
    await userEvent.type(screen.getByLabelText('Name'), 'Bob')
    await userEvent.click(screen.getByRole('button', { name: 'Request access' }))

    await waitFor(() => expect(screen.getByText(/we'll email you a link/)).toBeDefined())
    expect(calls).toEqual([
      { url: '/api/auth/request', method: 'POST', body: { email: 'bob@example.com', name: 'Bob', note: '', website: '' } },
    ])
    // The form is replaced, so a re-submit isn't one click away.
    expect(screen.queryByRole('button')).toBe(null)
  })

  it('surfaces rate-limiting and invalid addresses distinctly', async () => {
    stubFetch({ '/api/auth/request': { status: 429, body: { status: 'rate-limited' } } })
    renderWithQuery(<RequestAccessForm askName={false} askNote={false} />)
    await userEvent.type(screen.getByLabelText('Email'), 'bob@example.com')
    await userEvent.click(screen.getByRole('button', { name: 'Request access' }))
    await waitFor(() => expect(screen.getByText("That's a lot of requests. Try again in a little while.")).toBeDefined())
  })

  it('carries a honeypot field that is hidden from people and assistive tech', () => {
    const { container } = renderWithQuery(<RequestAccessForm />)
    const pot = container.querySelector('input[name="website"]')!
    expect([pot.getAttribute('aria-hidden'), pot.getAttribute('tabindex'), pot.getAttribute('autocomplete')]).toEqual([
      'true',
      '-1',
      'off',
    ])
    expect(screen.queryByLabelText('website')).toBe(null)
  })
})

describe('AccessNotice', () => {
  it('names the recipient and discloses the logging', () => {
    const { container } = renderWithQuery(<AccessNotice whoami={GRANT} />)
    expect(container.textContent).toBe('Private link for Bob Smith · access is logged')
  })

  it('drops the logging claim when views are not logged, so the copy stays true', () => {
    const { container } = renderWithQuery(<AccessNotice whoami={GRANT} logged={false} />)
    expect(container.textContent).toBe('Private link for Bob Smith')
  })

  it('can show the viewer their own trail', () => {
    const { container } = renderWithQuery(<AccessNotice whoami={GRANT} viewCount={1} />)
    expect(container.textContent).toBe("Private link for Bob Smith · access is logged · you've viewed this 1 time")
  })

  it('renders nothing without an identity', () => {
    const { container } = renderWithQuery(<AccessNotice whoami={null} />)
    expect(container.textContent).toBe('')
  })
})

describe('devIdentity', () => {
  it('stubs the identity without probing — Tier 1 has no get-identity locally', async () => {
    const calls = stubFetch({})
    renderWithQuery(
      <AuthGate
        source={{ kind: 'edge' }}
        devIdentity={{ email: 'dev@example.test' }}
        signIn={<div>WALL</div>}
      >
        {w => <div>APP:{displayName(w)}</div>}
      </AuthGate>,
    )
    await waitFor(() => expect(screen.getByText('APP:dev@example.test')).toBeDefined())
    expect(calls).toEqual([])
  })

  it('null forces the wall, so it can be eyeballed without a deploy', async () => {
    const calls = stubFetch({})
    renderWithQuery(
      <AuthGate source={{ kind: 'edge' }} devIdentity={null} signIn={<div>WALL</div>}>
        {() => <div>APP</div>}
      </AuthGate>,
    )
    await waitFor(() => expect(screen.getByText('WALL')).toBeDefined())
    expect(calls).toEqual([])
  })

  it('undefined probes normally, so production is untouched', async () => {
    const calls = stubFetch({ '/cdn-cgi/access/get-identity': { status: 200, body: { email: 'real@x.test' } } })
    renderWithQuery(
      <AuthGate source={{ kind: 'edge' }} devIdentity={undefined} signIn={<div>WALL</div>}>
        {w => <div>APP:{displayName(w)}</div>}
      </AuthGate>,
    )
    await waitFor(() => expect(screen.getByText('APP:real@x.test')).toBeDefined())
    expect(calls.map(c => c.url)).toEqual(['/cdn-cgi/access/get-identity'])
  })
})

describe('signing out', () => {
  /** The gate and the chip over one client, which is how an app actually mounts them. */
  const signedIn = () =>
    renderWithQuery(
      <AuthGate source={{ kind: 'app' }} signIn={<div>WALL</div>}>
        {w => (
          <div>
            APP:{displayName(w)}
            <WhoamiChip whoami={w} />
          </div>
        )}
      </AuthGate>,
    )

  it('re-renders the wall, rather than leaving the dead identity on screen', async () => {
    const calls = stubFetch({
      '/api/auth/whoami': { status: 200, body: GRANT },
      '/api/auth/logout': { status: 200, body: { ok: true } },
    })
    signedIn()
    await waitFor(() => expect(screen.getByText('APP:Bob Smith')).toBeDefined())

    // The cookie is already gone at this point; the bug was purely that no
    // mounted observer heard about it, so the page kept rendering the identity.
    calls.length = 0
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'unauthenticated' }), { status: 401 })) as typeof fetch
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }))

    await waitFor(() => expect(screen.getByText('WALL')).toBeDefined())
    expect(screen.queryByText('APP:Bob Smith')).toBe(null)
  })
})
