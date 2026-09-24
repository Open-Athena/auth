import { type Grant, subjectName } from '@open-athena/auth'
import { AllowlistPanel, type AppWhoami, Avatar, useWhoami } from '@open-athena/auth/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type FormEvent, useEffect, useState } from 'react'
import { ago, api, startSandbox } from '../api.js'

const SOURCE = { kind: 'app', endpoint: '/api/admin/whoami' } as const
const SANDBOX_KEY = 'oa-auth-demo:sandbox'

export function Admin() {
  const { whoami, refresh } = useWhoami<AppWhoami>(SOURCE)
  // A staff member who signed in with Google holds a *view* session; promote it
  // to the admin gate once (`/api/staff` 403s anyone outside the staff domain).
  const [promoted, setPromoted] = useState<boolean | null>(null)
  useEffect(() => {
    if (whoami !== null || promoted !== null) return
    void fetch('/api/staff', { method: 'POST', credentials: 'include' }).then(res => {
      setPromoted(res.ok)
      if (res.ok) refresh()
    })
  }, [whoami, promoted, refresh])
  if (whoami === undefined || (whoami === null && promoted === null)) return <p className="muted">Checking…</p>
  if (whoami === null) return <StartSandbox onStarted={refresh} />
  return <Console whoami={whoami} />
}

function StartSandbox({ onStarted }: { onStarted: () => void }) {
  const [busy, setBusy] = useState(false)
  return (
    <div className="wall">
      <h1>Admin</h1>
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
        Staff (<code>@openathena.ai</code>) can instead <a href="/auth/google/start?next=%2Fadmin">sign in with Google</a>,
        which also unlocks the access-request queue.
      </p>
    </div>
  )
}

/** `demo-brave-otter@sandbox.invalid` → `brave-otter`; a staff address stays as is. */
const sandboxName = (email: string): string | null => {
  const m = /^demo-([a-z]+-[a-z]+)@sandbox\.invalid$/.exec(email)
  return m ? m[1]! : null
}

const clock = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

function Console({ whoami }: { whoami: AppWhoami }) {
  const qc = useQueryClient()
  const [tokens, setTokens] = useState<Record<string, string>>({})
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['grants'] })
    void qc.invalidateQueries({ queryKey: ['log'] })
  }

  const grants = useQuery({ queryKey: ['grants'], queryFn: api.grants, refetchInterval: 5000 })
  const log = useQuery({ queryKey: ['log'], queryFn: () => api.log(60), refetchInterval: 5000 })

  // The only moment a raw token exists outside the recipient's browser is the
  // response that minted (or rotated) it.
  const showToken = (id: string, token: string) => setTokens(t => ({ ...t, [id]: token }))
  const mint = useMutation({
    mutationFn: api.mint,
    onSuccess: ({ grant, token }) => {
      showToken(grant.id, token)
      invalidate()
    },
  })

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    const days = Number(f.get('days'))
    const max = Number(f.get('max'))
    mint.mutate({
      name: String(f.get('memo') || '').trim() || null,
      first: String(f.get('first') || '').trim(),
      last: String(f.get('last') || '').trim(),
      scopes: ['reports'],
      maxRedeems: max > 0 ? max : null,
      expiresInS: days > 0 ? days * 86400 : null,
    })
  }

  const email = whoami.kind === 'sso' ? whoami.email : 'unknown'
  const sandbox = sandboxName(email)

  return (
    <div className="console">
      <header className="dash-head">
        <div>
          <h1>Admin</h1>
          <p className="muted small">
            {sandbox ? (
              <>
                Sandbox <code>{sandbox}</code> — throwaway, and yours alone.
              </>
            ) : (
              <>
                Acting as <code>{email}</code>
              </>
            )}
          </p>
        </div>
      </header>

      <section className="panel">
        <h2>Mint a share link</h2>
        <p className="muted small">
          A link minted here is real: it opens the dashboard for anyone in the world, until you disable, rotate or
          revoke it.
        </p>
        <form className="mint" onSubmit={submit}>
          <label>
            Memo <span className="muted">(what is this link for?)</span>
            {/* Pre-filled and optional: minting should cost one click. It's a
                note to whoever reads this table later, not a recipient's name —
                the recipient's identity is the fields below, when you want it. */}
            <input name="memo" defaultValue={`${sandbox ?? 'test'} · ${clock()}`} />
          </label>
          <label>
            Recipient <span className="muted">(optional — puts a name on the page)</span>
            <input name="first" placeholder="Ada" autoComplete="off" />
          </label>
          <label>
            <span className="muted">Last name</span>
            <input name="last" placeholder="Lovelace" autoComplete="off" />
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
        <p className="muted small">
          Three verbs, because "stop handing this out" and "throw everyone out" are different actions:{' '}
          <strong>disable</strong> stops new redemptions and is reversible; <strong>rotate</strong> re-keys a leaked
          link and keeps its terms; <strong>revoke</strong> ends every session it ever minted, permanently.
        </p>
        {grants.isPending && <p className="muted">Loading…</p>}
        {grants.data?.length === 0 && <p className="muted">None yet — mint one above.</p>}
        <div className="grants">
          {grants.data?.map(g => (
            <GrantCard key={g.id} grant={g} token={tokens[g.id]} onChanged={invalidate} onToken={showToken} />
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

      <Allowlist />

      {whoami.scopes.includes('requests') && <RequestQueue onChange={invalidate} />}
    </div>
  )
}

function GrantCard({
  grant,
  token,
  onChanged,
  onToken,
}: {
  grant: Grant
  token?: string
  onChanged: () => void
  onToken: (id: string, token: string) => void
}) {
  const [copied, setCopied] = useState(false)
  const activity = useQuery({
    queryKey: ['activity', grant.id],
    queryFn: () => api.activity(grant.id),
    refetchInterval: 5000,
  })
  const revoke = useMutation({ mutationFn: api.revoke, onSuccess: onChanged })
  const disable = useMutation({ mutationFn: api.disable, onSuccess: onChanged })
  const enable = useMutation({ mutationFn: api.enable, onSuccess: onChanged })
  const rotate = useMutation({
    mutationFn: api.rotate,
    onSuccess: r => {
      onToken(r.id, r.token)
      onChanged()
    },
  })
  const busy = revoke.isPending || disable.isPending || enable.isPending || rotate.isPending

  const revoked = grant.revokedAt !== null
  const disabled = grant.disabledAt !== null
  const expired = grant.expiresAt !== null && grant.expiresAt * 1000 < Date.now()
  const url = token ? `${window.location.origin}/dashboard?key=${token}` : null
  // 1–3 redemptions is one person on their phone, laptop and work machine.
  // Many more, especially across countries, is the forwarding signal — a soft
  // badge, deliberately not an alarm.
  const spread = (activity.data?.distinctIps ?? 0) > 3 || (activity.data?.countries.length ?? 0) > 2

  return (
    <article className={`grant${revoked ? ' revoked' : ''}`}>
      <header>
        <h3>{grant.name ?? 'No memo'}</h3>
        {revoked ? (
          <span className="tag dead">revoked</span>
        ) : expired ? (
          <span className="tag dead">expired</span>
        ) : (
          <div className="row">
            {disabled ? (
              <button className="btn small" type="button" disabled={busy} onClick={() => enable.mutate(grant.id)}>
                Enable
              </button>
            ) : (
              <button className="btn small" type="button" disabled={busy} onClick={() => disable.mutate(grant.id)}>
                Disable
              </button>
            )}
            <button className="btn small" type="button" disabled={busy} onClick={() => rotate.mutate(grant.id)}>
              Rotate
            </button>
            <button className="btn small danger" type="button" disabled={busy} onClick={() => revoke.mutate(grant.id)}>
              Revoke
            </button>
          </div>
        )}
      </header>
      {disabled && !revoked && (
        <p className="muted small">
          <span className="tag soft">disabled</span> No new redemptions; anyone already in stays in.
        </p>
      )}
      {grant.subject && <p className="muted small">for {subjectName(grant.subject)}</p>}

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
        !revoked && <p className="muted small">Link shown once at mint. Rotate it for a fresh one if you lost it.</p>
      )}
    </article>
  )
}

/**
 * The allowlist table an SSO policy can read, with a directory sync. Not wired
 * into any policy here — the demo admits anyone by email — which is the honest
 * demonstration of a real property: mounting the editor never changes who gets
 * in; `allowlistPolicy(store)` in the gate's `policy` is the separate line that
 * does.
 */
function Allowlist() {
  return (
    <section className="panel">
      <h2>Allowlist</h2>
      <p className="muted small">
        "Who's allowed" as a table, not a redeploy: <code>allowlistPolicy(store)</code> reads it on every sign-in, so a
        change here is live on the next request. Rows arrive by hand (below) or from a directory sync that owns its
        own <code>source</code> — <strong>Sync now</strong> here runs a <em>simulated</em> one, a random subset of a
        five-person <code>staff@example.org</code>, so you can watch a member drop out and come back. A real deployment
        calls <code>syncGroupsToAllowlist</code> at that spot, with a service-account key; see the README.
      </p>
      <AllowlistPanel
        endpoint="/api/admin/allowed"
        defaultScopes={['reports']}
        sync
        classNames={{
          root: 'allowlist',
          form: 'row',
          input: 'input',
          button: 'btn',
          sync: 'btn sync',
          table: 'allow-table',
          source: 'tag soft',
          remove: 'btn small',
          message: 'muted small',
          empty: 'muted small',
        }}
        labels={{ email: 'someone@example.org', synced: 'synced from staff@example.org', manual: 'added by you' }}
      />
      <p className="muted small">
        Hand-added rows are yours alone; synced rows are shared across sandboxes (the simulated group is one group).
        This table isn't wired to a policy in the demo, which admits any address — mounting the editor never changes
        who gets in.
      </p>
    </section>
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
          <div className="row">
            {/* A queue of addresses is a queue of strangers; a queue of names
                and faces is a queue of people, which is the whole point of
                asking for a name at request time. */}
            <Avatar name={subjectName(r.subject) ?? r.name} size={28} className="avatar" />
            <div>
              <strong>{subjectName(r.subject) ?? r.name ?? r.email}</strong>
              {(subjectName(r.subject) ?? r.name) && <span className="muted small"> · {r.email}</span>}
              {r.note && <p className="muted small">{r.note}</p>}
            </div>
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
