import { type Grant, subjectName } from '@open-athena/auth'
import { createAuthClient, createGrantsController, shareUrl } from '@open-athena/auth/client'
import { AllowlistPanel, Avatar, GrantsPanel, type GrantsClassNames, type Whoami, useWhoami } from '@open-athena/auth/react'
import { UserMenu } from '@open-athena/auth/react/user-menu'
import { SessionLogSwitch } from '@open-athena/auth/react/session-log'
import { slog } from '@open-athena/auth/session-log/client'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { ago, api, startSandbox } from '../api.js'
import { Link } from '../router.js'

const SOURCE = { endpoint: '/api/admin/whoami' } as const
const SANDBOX_KEY = 'oa-auth-demo:sandbox'
const client = createAuthClient({ basePath: '/api/admin' })
const SCOPES = [{ id: 'reports', label: 'The dashboard' }]

/** The package's parts wearing this site's stylesheet. */
const GRANT_CLASSES: GrantsClassNames & { section: string } = {
  panel: 'grants-panel',
  section: 'panel',
  form: 'mint',
  check: 'check',
  input: '',
  muted: 'muted small',
  error: 'err',
  button: 'btn small',
  primary: 'btn primary',
  danger: 'btn small danger',
  linkish: 'linkish',
  list: 'grants',
  card: 'grant',
  cardRevoked: 'grant revoked',
  cardHead: '',
  row: 'row',
  tag: 'tag soft',
  tagDead: 'tag dead',
  facts: 'facts',
  holder: 'muted small for',
  holderForm: 'holder-edit',
  token: 'tokenbox',
  copyRow: 'copyrow',
  avatarField: 'avatar-field',
  avatar: { row: 'avatar-row', input: 'input', button: 'btn small', hint: 'muted small' },
}

const buildLink = (_: Grant, token: string) => shareUrl(token, `${window.location.origin}/dashboard`)

export function Admin() {
  const { whoami, refresh } = useWhoami<Whoami>(SOURCE)
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

function Console({ whoami }: { whoami: Whoami }) {
  const qc = useQueryClient()
  // Minting or binding with "also let this email sign in" adds an allowlist
  // row; the panel loads its own rows, so a link change remounts it.
  const [allowlistKey, setAllowlistKey] = useState(0)
  const controller = useMemo(() => createGrantsController({ client }), [])
  const refreshLog = () => {
    void qc.invalidateQueries({ queryKey: ['log'] })
    setAllowlistKey(k => k + 1)
  }
  const invalidate = () => {
    void controller.refresh()
    refreshLog()
  }

  const log = useQuery({ queryKey: ['log'], queryFn: () => api.log(60), refetchInterval: 5000 })

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
        <UserMenu whoami={whoami} client={client} profile={false} items={[{ key: 'dashboard', label: 'Dashboard', href: '/dashboard' }]} />
      </header>

      <GrantsPanel
        controller={controller}
        scopes={SCOPES}
        buildLink={buildLink}
        pollMs={5000}
        allowlist
        avatarEndpoint="/api/admin/avatar"
        // Pre-filled and optional: minting should cost one click. It's a note to
        // whoever reads this table later, not a recipient's name: that's the field below.
        defaultMemo={() => `${sandbox ?? 'test'} · ${clock()}`}
        onMinted={grant => {
          // An app event (declared on the server's `appEvents`): a no-op while the session log is off.
          slog('demo.mint', { scopes: grant.scopes.join(','), expires: grant.expiresAt !== null })
        }}
        onChanged={refreshLog}
        classNames={GRANT_CLASSES}
        listHeading="Your links"
        emptyLabel="None yet — mint one above."
        mintIntro={
          <p className="muted small">
            A link minted here is real: it opens the dashboard for anyone in the world, until you disable, rotate or
            revoke it.
          </p>
        }
        listIntro={
          <>
            <p className="muted small">
              Three verbs, because "stop handing this out" and "throw everyone out" are different actions:{' '}
              <strong>disable</strong> stops new redemptions and is reversible; <strong>rotate</strong> re-keys a leaked
              link and keeps its terms; <strong>revoke</strong> ends every session it ever minted, permanently.
            </p>
            <p className="muted small">
              Redemptions count <em>sessions minted</em> — roughly distinct browsers — not requests, which is what makes
              "one-use link" mean what you'd predict. In practice <code>1</code> is hostile UX: the recipient opens it on
              their phone, then their laptop, and is locked out. Prefer unlimited, named, logged and revocable.
            </p>
          </>
        }
        labels={{
          memo: <>Memo <span className="muted">(what is this link for?)</span></>,
          holder: <>Recipient <span className="muted">(optional — puts a name on the page)</span></>,
          email: <>Email <span className="muted">(optional — who the link is for)</span></>,
          allowlist: 'Also let this email sign in with Google or an emailed code (adds it to the allowlist below)',
          avatar: <>Face <span className="muted">(optional — their Gravatar if they have one; or paste a profile, or upload)</span></>,
        }}
        cardLabels={{
          warning: "Copy this now — only its hash is stored, so it can't be shown again. Open it in a private window to see the recipient's view.",
          allowlist: 'Also let this email sign in with Google or an emailed code',
        }}
      />

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

      <Allowlist key={allowlistKey} />

      {whoami.scopes.includes('requests') && <RequestQueue onChange={invalidate} />}

      {whoami.scopes.includes('requests') && (
        <SessionLogSwitch
          className="card oa-slog-switch"
          description={
            <p className="muted">
              Records what signed-in visitors do here (pages, clicks on controls, requests, errors), to replay a reported
              bug at <Link to="/admin/sessions">/admin/sessions</Link>. Off by default; it turns itself off after the
              chosen day. Staff only, like the request queue: a session names its visitor.
            </p>
          }
        />
      )}
    </div>
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
