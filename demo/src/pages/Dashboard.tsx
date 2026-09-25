import {
  AccessNotice,
  AuthGate,
  RequestAccessForm,
  type Whoami,
  displayName,
} from '@open-athena/auth/react'
import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import { ApiError, VIEW_SOURCE, api } from '../api.js'
import { Link } from '../router.js'
import { SignIn } from '../SignIn.js'

export function Dashboard() {
  return (
    <AuthGate<Whoami>
      source={VIEW_SOURCE}
      exchange={{ endpoint: '/api/view/exchange' }}
      loading={<p className="muted">Checking your access…</p>}
      signIn={refresh => <Wall onSignedIn={refresh} />}
    >
      {(whoami, refresh) => <Gated whoami={whoami} onLost={refresh} />}
    </AuthGate>
  )
}

/**
 * A revoked or expired link lands here rather than on a bare 403: the person who
 * legitimately lost access self-serves, and the person who shouldn't have it
 * hits a door that names itself. `useWhoami` re-probes on window focus while
 * signed out, so a link redeemed in another tab is noticed on the way back.
 */
function Wall({ onSignedIn }: { onSignedIn: () => void }) {
  return (
    <div className="wall">
      <SignIn title="This dashboard is private" onSignedIn={onSignedIn} />

      <details className="note">
        <summary>Don't have access? Ask for it</summary>
        <p className="muted small">
          What a stricter policy shows instead of the email form above. This lands in the staff queue on the Admin
          page; approving it mints a link bound to your address, and the name you give is what the page will greet you
          by.
        </p>
        <RequestAccessForm
          // The admin gate's policy doesn't admit strangers, so a request stays
          // pending for the queue instead of being auto-approved by the
          // admit-anyone view policy.
          endpoint="/api/admin/request"
          askName
          notePlaceholder="Board member, reviewing Q3"
          classNames={{ form: 'stack', field: 'field', input: 'input', button: 'btn', message: 'ok' }}
          labels={{ submit: 'Request access' }}
        />
      </details>

      <p className="muted small">
        Or <Link to="/">open a demo link</Link>, or <Link to="/admin">mint your own</Link>.
      </p>
    </div>
  )
}

function Gated({ whoami, onLost }: { whoami: Whoami; onLost: () => void }) {
  // The gated fetch, polled: a link revoked in the admin page fails it within
  // five seconds, and the page drops back to the wall instead of showing a
  // stale page with an error tucked in a corner.
  const probe = useQuery({ queryKey: ['private'], queryFn: api.privateData, retry: false, refetchInterval: 5000 })

  useEffect(() => {
    if (probe.error instanceof ApiError && [401, 403].includes(probe.error.status)) onLost()
  }, [probe.error, onLost])

  if (probe.error) return <p className="err">Access ended: {probe.error.message}</p>

  return (
    <div className="dash">
      <h1>You're in.</h1>
      <p className="muted small">
        The private data would be here. It isn't the interesting part; what the gate knows about you is.
      </p>

      <AccessNotice whoami={whoami} className="disclosure" />

      <div className="placeholder identity">
        <dl className="facts big">
          {identityFacts(whoami).map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      </div>

      <h2>Come back another way</h2>
      <p className="muted small">
        Sign out (top right) and come back through a different door — the page is the same, but what it knows about
        you isn't. A link minted with a name greets you by it; an anonymous one can't; an email session is you.
      </p>
      <ul>
        <li>
          <Link to="/">Sign in with an emailed code</Link>, or Google — one <code>gate.signIn</code> for both.
        </li>
        <li>
          <Link to="/">Open the named or the anonymous demo link</Link> and compare the chip in the corner.
        </li>
        <li>
          <Link to="/admin">Mint your own</Link>, then disable, rotate or revoke it and watch this page fall back to the
          wall.
        </li>
      </ul>

    </div>
  )
}

/** What the gate knows, which is the actual subject of this page. */
function identityFacts(whoami: Whoami): [string, string][] {
  const when = (ts: number | null | undefined) => (ts ? new Date(ts * 1000).toLocaleString() : 'never')
  if (whoami.kind === 'sso') {
    return [
      ['Subject', `e:${whoami.email}`],
      [
        'How you got in',
        'An email session: Google or an emailed code. The gate can\'t tell which — both end in gate.signIn.',
      ],
      ['Known as', displayName(whoami) ?? whoami.email],
      ['Scopes', whoami.scopes.join(', ') || 'none'],
      ['Expires', 'With the session cookie — or the moment policy stops admitting this address, on the next request.'],
    ]
  }
  return [
    // The real session subject, not a prettified stand-in: a link session is
    // identified by the *link*, which is exactly what makes it anonymous.
    ['Subject', `g:${whoami.id}`],
    ['How you got in', 'A share link, exchanged for a session. Revoking the link ends this session on its next request.'],
    ['Link knows you as', displayName(whoami) ?? '— nothing; this link is anonymous'],
    ['Link memo', whoami.name ?? '—'],
    ['Scopes', whoami.scopes.join(', ') || 'none'],
    ['Expires', when(whoami.expiresAt)],
  ]
}
