import type { Grant } from '@open-athena/auth'
import { type AppWhoami, useWhoami } from '@open-athena/auth/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type FormEvent, useState } from 'react'
import { ago, api, startSandbox } from '../api.js'
import { Link } from '../router.js'

const SOURCE = { kind: 'app', endpoint: '/api/admin/whoami' } as const
const SANDBOX_KEY = 'oa-auth-demo:sandbox'

export function Admin() {
  const { whoami, refresh } = useWhoami<AppWhoami>(SOURCE)
  if (whoami === undefined) return <p className="muted">Checking…</p>
  if (whoami === null) return <StartSandbox onStarted={refresh} />
  return <Console whoami={whoami} />
}

function StartSandbox({ onStarted }: { onStarted: () => void }) {
  const [busy, setBusy] = useState(false)
  return (
    <div className="wall">
      <h1>Console</h1>
      <p className="muted">
        A sandbox gives you a throwaway identity so you can mint links, watch their activity and revoke them. Every read
        and write is filtered to grants <em>you</em> created — other visitors' links are invisible to you, and someone
        else's grant id comes back 404 rather than 403, so ids stay unconfirmed.
      </p>
      <p className="muted small">
        Your sandbox deliberately can't open the dashboard. That's the demo: mint yourself a link and use it like a
        recipient would.
      </p>
      <button
        className="btn primary"
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          const id = await startSandbox(localStorage.getItem(SANDBOX_KEY))
          localStorage.setItem(SANDBOX_KEY, id.id)
          onStarted()
          setBusy(false)
        }}
      >
        {busy ? 'Starting…' : 'Start a sandbox'}
      </button>
      <p className="muted small">
        Staff can instead <a href="/auth/sso?next=%2Fadmin">sign in with SSO</a>, which also unlocks the access-request
        queue.
      </p>
    </div>
  )
}

function Console({ whoami }: { whoami: AppWhoami }) {
  const qc = useQueryClient()
  const [tokens, setTokens] = useState<Record<string, string>>({})
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['grants'] })
    void qc.invalidateQueries({ queryKey: ['log'] })
  }

  const grants = useQuery({ queryKey: ['grants'], queryFn: api.grants, refetchInterval: 5000 })
  const log = useQuery({ queryKey: ['log'], queryFn: () => api.log(60), refetchInterval: 5000 })

  const mint = useMutation({
    mutationFn: api.mint,
    onSuccess: ({ grant, token }) => {
      // The only moment this token exists outside the recipient's browser.
      setTokens(t => ({ ...t, [grant.id]: token }))
      invalidate()
    },
  })
  const revoke = useMutation({ mutationFn: api.revoke, onSuccess: invalidate })

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    const days = Number(f.get('days'))
    const max = Number(f.get('max'))
    mint.mutate({
      name: String(f.get('name') || '').trim() || 'Unnamed link',
      note: String(f.get('note') || ''),
      scopes: ['reports'],
      maxRedeems: max > 0 ? max : null,
      expiresInS: days > 0 ? days * 86400 : null,
    })
  }

  const identity = whoami.kind === 'sso' ? whoami.email : 'unknown'

  return (
    <div className="console">
      <header className="dash-head">
        <div>
          <h1>Console</h1>
          <p className="muted small">
            Acting as <code>{identity}</code>
          </p>
        </div>
      </header>

      <section className="panel">
        <h2>Mint a share link</h2>
        <form className="mint" onSubmit={submit}>
          <label>
            Name it after the recipient
            <input name="name" placeholder="Bob Smith (donor)" required />
          </label>
          <label>
            Note <span className="muted">(why does this exist?)</span>
            <input name="note" placeholder="Q3 board packet" />
          </label>
          <label>
            Expires in
            <select name="days" defaultValue="30">
              <option value="0">never</option>
              <option value="1">1 day</option>
              <option value="7">7 days</option>
              <option value="30">30 days</option>
            </select>
          </label>
          <label>
            Max redemptions
            <select name="max" defaultValue="0">
              <option value="0">unlimited</option>
              <option value="1">1 (see note)</option>
              <option value="3">3</option>
            </select>
          </label>
          <button className="btn primary" type="submit" disabled={mint.isPending}>
            {mint.isPending ? 'Minting…' : 'Mint link'}
          </button>
        </form>
        <p className="muted small">
          Redemptions count <em>sessions minted</em> — roughly distinct browsers — not requests, which is what makes
          "one-use link" mean what you'd predict. In practice <code>1</code> is hostile UX: the recipient opens it on
          their phone, then their laptop, and is locked out. Prefer unlimited, named, logged and revocable.
        </p>
        {mint.error && <p className="err">{(mint.error as Error).message}</p>}
      </section>

      <section className="panel">
        <h2>Your links</h2>
        {grants.isPending && <p className="muted">Loading…</p>}
        {grants.data?.length === 0 && <p className="muted">None yet — mint one above.</p>}
        <div className="grants">
          {grants.data?.map(g => (
            <GrantCard key={g.id} grant={g} token={tokens[g.id]} onRevoke={() => revoke.mutate(g.id)} />
          ))}
        </div>
      </section>

      <section className="panel">
        <h2>Access log</h2>
        <p className="muted small">
          Every event across your links. Client IPs are never stored — only an HMAC of them, which is enough to count
          distinct viewers without retaining addresses.
        </p>
        <table className="log">
          <thead>
            <tr>
              <th>When</th>
              <th>Event</th>
              <th>Path</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {log.data?.map(e => (
              <tr key={e.id}>
                <td className="muted">{ago(e.ts)}</td>
                <td>
                  <span className={`ev ev-${e.event}`}>{e.event}</span>
                </td>
                <td>
                  <code>{e.path ?? '—'}</code>
                </td>
                <td className="muted">{e.reason ?? e.country ?? ''}</td>
              </tr>
            ))}
            {log.data?.length === 0 && (
              <tr>
                <td colSpan={4} className="muted">
                  Nothing yet. Open one of your links and this fills in.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      {whoami.scopes.includes('requests') && <RequestQueue onChange={invalidate} />}
    </div>
  )
}

function GrantCard({ grant, token, onRevoke }: { grant: Grant; token?: string; onRevoke: () => void }) {
  const [copied, setCopied] = useState(false)
  const activity = useQuery({
    queryKey: ['activity', grant.id],
    queryFn: () => api.activity(grant.id),
    refetchInterval: 5000,
  })
  const revoked = grant.revokedAt !== null
  const expired = grant.expiresAt !== null && grant.expiresAt * 1000 < Date.now()
  const url = token ? `${window.location.origin}/dashboard?key=${token}` : null
  // 1–3 redemptions is one person on their phone, laptop and work machine.
  // Many more, especially across countries, is the forwarding signal — a soft
  // badge, deliberately not an alarm.
  const spread = (activity.data?.distinctIps ?? 0) > 3 || (activity.data?.countries.length ?? 0) > 2

  return (
    <article className={`grant${revoked ? ' revoked' : ''}`}>
      <header>
        <h3>{grant.name ?? 'Unnamed link'}</h3>
        {revoked ? (
          <span className="tag dead">revoked</span>
        ) : expired ? (
          <span className="tag dead">expired</span>
        ) : (
          <button className="btn small danger" type="button" onClick={onRevoke}>
            Revoke
          </button>
        )}
      </header>
      {grant.note && <p className="muted small">{grant.note}</p>}

      <dl className="facts">
        <div>
          <dt>redemptions</dt>
          <dd>
            {grant.redeems}
            {grant.maxRedeems !== null && ` / ${grant.maxRedeems}`}
          </dd>
        </div>
        <div>
          <dt>views</dt>
          <dd>{activity.data?.views ?? 0}</dd>
        </div>
        <div>
          <dt>distinct clients</dt>
          <dd>
            {activity.data?.distinctIps ?? 0} {spread && <span className="tag soft">widely opened</span>}
          </dd>
        </div>
        <div>
          <dt>last seen</dt>
          <dd>{ago(grant.lastUsedAt)}</dd>
        </div>
        <div>
          <dt>expires</dt>
          <dd>{grant.expiresAt === null ? 'never' : new Date(grant.expiresAt * 1000).toLocaleDateString()}</dd>
        </div>
      </dl>

      {activity.data && activity.data.topPaths.length > 0 && (
        <p className="muted small">
          mostly {activity.data.topPaths.map(p => `${p.path} (${p.views})`).join(', ')}
          {activity.data.countries.length > 0 && ` · from ${activity.data.countries.join(', ')}`}
        </p>
      )}

      {url ? (
        <div className="tokenbox">
          <p className="muted small">
            Copy this now — only its hash is stored, so it can't be shown again. Open it in a private window to see the
            recipient's view.
          </p>
          <div className="copyrow">
            <input readOnly value={url} onFocus={e => e.currentTarget.select()} />
            <button
              className="btn small"
              type="button"
              onClick={async () => {
                await navigator.clipboard.writeText(url).catch(() => {})
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      ) : (
        !revoked && <p className="muted small">Link shown once at mint. Revoke and mint a fresh one if you lost it.</p>
      )}
    </article>
  )
}

function RequestQueue({ onChange }: { onChange: () => void }) {
  const requests = useQuery({ queryKey: ['requests'], queryFn: api.requests, refetchInterval: 10_000 })
  const qc = useQueryClient()
  const [issued, setIssued] = useState<Record<string, string>>({})
  const done = () => {
    void qc.invalidateQueries({ queryKey: ['requests'] })
    onChange()
  }
  const approve = useMutation({
    mutationFn: api.approve,
    onSuccess: ({ grant, token }) => {
      setIssued(s => ({ ...s, [grant.id]: token }))
      done()
    },
  })
  const deny = useMutation({ mutationFn: api.deny, onSuccess: done })

  return (
    <section className="panel">
      <h2>Access requests</h2>
      <p className="muted small">
        Staff only — the queue holds strangers' email addresses, which is a higher bar than minting your own link.
        Approving mints a link bound to that address and hands it to the app's <code>notify</code> hook; this demo
        prints it here instead of sending mail.
      </p>
      {requests.data?.length === 0 && <p className="muted">Nothing pending.</p>}
      {requests.data?.map(r => (
        <div key={r.id} className="request">
          <div>
            <strong>{r.email}</strong>
            {r.name && ` · ${r.name}`}
            {r.note && <p className="muted small">{r.note}</p>}
          </div>
          <div className="row">
            <button className="btn small primary" type="button" onClick={() => approve.mutate(r.id)}>
              Approve
            </button>
            <button className="btn small" type="button" onClick={() => deny.mutate(r.id)}>
              Deny
            </button>
          </div>
        </div>
      ))}
      {Object.entries(issued).map(([id, token]) => (
        <p key={id} className="ok small">
          Minted: <code>{`${window.location.origin}/dashboard?key=${token}`}</code>
        </p>
      ))}
    </section>
  )
}

export function AdminFooter() {
  return (
    <p className="muted small">
      Sandboxes are throwaway. <Link to="/">What is this?</Link>
    </p>
  )
}
