import { AccessNotice, AuthGate, RequestAccessForm, Watermark, WhoamiChip, type AppWhoami } from '@open-athena/auth/react'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { ApiError, api, money } from '../api.js'
import { Link } from '../router.js'

const SOURCE = { kind: 'app', endpoint: '/api/view/whoami' } as const

export function Dashboard() {
  return (
    <AuthGate<AppWhoami>
      source={SOURCE}
      exchange={{ endpoint: '/api/view/exchange' }}
      loading={<p className="muted">Checking your access…</p>}
      signIn={<Wall />}
    >
      {(whoami, refresh) => <Gated whoami={whoami} onLost={refresh} />}
    </AuthGate>
  )
}

/**
 * A revoked or expired link lands here rather than on a bare 403: the person who
 * legitimately lost access self-serves, and the person who shouldn't have it
 * hits a door that names itself.
 */
function Wall() {
  return (
    <div className="wall">
      <h1>This dashboard is private</h1>
      <p className="muted">
        It holds FY2025 giving figures. Staff can sign in; everyone else can ask, or open a link someone minted for
        them.
      </p>

      <div className="wall-actions">
        <a className="btn primary" href={`/auth/sso?next=${encodeURIComponent('/dashboard')}`}>
          Sign in with SSO
        </a>
        {/* No "I just opened a link — retry" button: `useWhoami` re-probes on
            window focus while signed out, so redeeming in another tab is
            noticed on the way back to this one. */}
      </div>

      <details className="note">
        <summary>Don't have access?</summary>
        <RequestAccess />
      </details>

      <p className="muted small">
        Want to try the other side? <Link to="/admin">Mint yourself a link</Link> in the admin panel, or{' '}
        <Link to="/">sign in with any email</Link>.
      </p>
    </div>
  )
}

function RequestAccess() {
  // The package's own form, in split-name mode: first/last are stored as the
  // same `Subject` a grant carries, so approving this request mints a link that
  // knows a person — which is what the watermark and the chip then render.
  return (
    <RequestAccessForm
      // This demo mounts `authRoutes` at `/api/view`, not the default `/api/auth`.
      endpoint="/api/view/request"
      askName="split"
      notePlaceholder="Board member, reviewing Q3"
      classNames={{ form: 'stack', field: 'field', input: 'input', button: 'btn', message: 'ok' }}
      labels={{ submit: 'Request access' }}
    />
  )
}

function Gated({ whoami, onLost }: { whoami: AppWhoami; onLost: () => void }) {
  const [watermark, setWatermark] = useState(true)
  const summary = useQuery({ queryKey: ['summary'], queryFn: api.summary, retry: false })

  // Revocation lands mid-session: the next fetch 401s, so drop back to the wall
  // instead of showing a stale page with an error tucked in a corner.
  useEffect(() => {
    if (summary.error instanceof ApiError && [401, 403].includes(summary.error.status)) onLost()
  }, [summary.error, onLost])

  if (summary.isPending) return <p className="muted">Loading…</p>
  if (summary.error) return <p className="err">Access ended: {summary.error.message}</p>
  const data = summary.data

  return (
    <div className="dash">
      {watermark && <Watermark whoami={whoami} className="watermark" />}

      <header className="dash-head">
        <div>
          <h1>You're in.</h1>
          <p className="muted small">This page is gated. Below is everything the gate knows about you.</p>
        </div>
        {/* No `onSignedOut` on purpose: forgetting the identity is the hook's
            job, and an app-side refresh here would mask a regression in it —
            which is exactly how the `removeQueries` bug survived this demo. */}
        <WhoamiChip
          whoami={whoami}
          avatar
          logoutEndpoint="/api/view/logout"
          classNames={{ root: 'chip', name: 'chip-name', button: 'btn small', avatar: 'avatar' }}
        />
      </header>

      <AccessNotice whoami={whoami} className="disclosure" />

      <dl className="facts">
        {identityFacts(whoami).map(([k, v]) => (
          <div key={k}>
            <dt className="stat-label">{k}</dt>
            <dd className="stat-value small">{v}</dd>
          </div>
        ))}
      </dl>

      <div className="placeholder">
        <p className="muted">The private data would be here.</p>
        <p className="muted small">
          It isn't the interesting part — {data.title} is invented. What matters is that this page didn't render until
          the gate said who you were, and stops rendering the moment that stops being true.
        </p>
      </div>

      <h2>Try another way in</h2>
      <p className="muted small">
        Sign out and come back through a different door — the page is the same, but what it knows about you isn't. A
        link minted with a name greets you by it; an anonymous one can't.
      </p>
      <ul>
        <li>
          <Link to="/">Sign in with any email address</Link> — passwordless, no account row.
        </li>
        <li>
          <Link to="/">Open a named or anonymous demo link</Link> and compare the chip above.
        </li>
        <li>
          <Link to="/admin">Mint your own</Link>, then disable or revoke it and watch this page fall back to the wall.
        </li>
      </ul>

      <label className="toggle">
        <input type="checkbox" checked={watermark} onChange={e => setWatermark(e.target.checked)} /> Watermark this page
        with the recipient's name
      </label>
      <p className="muted small">
        The data-room convention: rendering the recipient's name in-page makes screenshots attributable. It costs
        nothing — the gate already knows who this link was minted for.
      </p>
    </div>
  )
}

/** What the gate knows, which is the actual subject of this page. */
function identityFacts(whoami: AppWhoami): [string, string][] {
  if (whoami.kind === 'sso') {
    return [
      ['How you got in', 'SSO'],
      ['Subject', `e:${whoami.email}`],
      ['Scopes', whoami.scopes.join(', ') || 'none'],
    ]
  }
  const person = [whoami.subject?.first, whoami.subject?.last].filter(Boolean).join(' ')
  return [
    ['How you got in', 'A share link'],
    // The real session subject, not a prettified stand-in: a link session is
    // identified by the *link*, which is exactly what makes it anonymous.
    ['Session subject', `g:${whoami.id}`],
    ['Link knows you as', person || whoami.name || '— nothing; this link is anonymous'],
    ['Link memo', whoami.name ?? '—'],
    ['Scopes', whoami.scopes.join(', ') || 'none'],
    ['Expires', whoami.expiresAt ? new Date(whoami.expiresAt * 1000).toLocaleString() : 'never'],
  ]
}
