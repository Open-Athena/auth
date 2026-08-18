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
          <h1>{data.title}</h1>
          <p className="muted small">Updated {data.updated} · invented figures, but shaped like the real thing</p>
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
