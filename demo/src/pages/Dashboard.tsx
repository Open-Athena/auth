import { AccessNotice, AuthGate, Watermark, WhoamiChip, type AppWhoami } from '@open-athena/auth/react'
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
      signIn={refresh => <Wall onRetry={refresh} />}
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
function Wall({ onRetry }: { onRetry: () => void }) {
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
        <button className="btn" type="button" onClick={onRetry}>
          I just opened a link — retry
        </button>
      </div>

      <details className="note">
        <summary>Don't have access?</summary>
        <RequestAccess />
      </details>

      <p className="muted small">
        Want to try the other side? <Link to="/admin">Mint yourself a link</Link> in the console, then open it here.
      </p>
    </div>
  )
}

function RequestAccess() {
  const [state, setState] = useState<'idle' | 'sending' | 'pending' | 'error'>('idle')
  if (state === 'pending')
    return <p className="ok">Thanks — an approval would email you a link. (Nothing is actually sent in this demo.)</p>
  return (
    <form
      className="stack"
      onSubmit={async e => {
        e.preventDefault()
        const data = Object.fromEntries(new FormData(e.currentTarget).entries())
        setState('sending')
        const res = await fetch('/api/view/request', {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(data),
        })
        setState(res.ok ? 'pending' : 'error')
      }}
    >
      <label>
        Email
        <input name="email" type="email" required placeholder="you@example.com" />
      </label>
      <label>
        Why? <span className="muted">(optional)</span>
        <input name="note" type="text" placeholder="Board member, reviewing Q3" />
      </label>
      {/* Honeypot: the server treats a filled value as a bot and stores nothing. */}
      <input name="website" type="text" tabIndex={-1} autoComplete="off" aria-hidden="true" className="hp" />
      <button className="btn" type="submit" disabled={state === 'sending'}>
        {state === 'sending' ? 'Sending…' : 'Request access'}
      </button>
      {state === 'error' && <p className="err">That didn't work. Rate limited, maybe?</p>}
    </form>
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
          <h1>{data.title}</h1>
          <p className="muted small">Updated {data.updated} · invented figures, but shaped like the real thing</p>
        </div>
        <WhoamiChip
          whoami={whoami}
          logoutEndpoint="/api/view/logout"
          onSignedOut={onLost}
          classNames={{ root: 'chip', name: 'chip-name', button: 'btn small' }}
        />
      </header>

      <AccessNotice whoami={whoami} className="disclosure" />

      <div className="totals">
        {(['committed', 'received', 'pledged'] as const).map(k => (
          <div key={k} className="stat">
            <span className="stat-label">{k}</span>
            <span className="stat-value">{money(data.totals[k])}</span>
          </div>
        ))}
      </div>

      <h2>By fund</h2>
      <table>
        <thead>
          <tr>
            <th>Fund</th>
            <th className="num">Committed</th>
            <th className="num">Received</th>
          </tr>
        </thead>
        <tbody>
          {data.funds.map(f => (
            <tr key={f.name}>
              <td>{f.name}</td>
              <td className="num">{money(f.committed)}</td>
              <td className="num">{money(f.received)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Top donors</h2>
      <table>
        <thead>
          <tr>
            <th>Donor</th>
            <th className="num">Amount</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {data.donors.map(d => (
            <tr key={d.name}>
              <td>{d.name}</td>
              <td className="num">{money(d.amount)}</td>
              <td>{d.status}</td>
            </tr>
          ))}
        </tbody>
      </table>

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
