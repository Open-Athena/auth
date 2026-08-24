import { useMutation } from '@tanstack/react-query'
import { type FormEvent, useState } from 'react'
import { Link } from '../router.js'

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
  return data
}

export function Home() {
  return (
    <div className="prose">
      <h1>
        <code>@open-athena/auth</code>
      </h1>
      <p className="lede">
        Named share links, SSO, and an access log for gated pages. Mint a link, name it after the person you're sending
        it to, and see what they looked at — or let anyone sign in with an email address. No password store, no account
        table.
      </p>

      <p>
        <Link to="/dashboard">The dashboard</Link> is gated. Here are three ways in, all of them real:
      </p>

      <SignUp />
      <DemoLinks />

      <p className="muted small">
        Or <a href="/auth/sso?next=%2Fdashboard">sign in with SSO</a> if you're staff — one Cloudflare Access
        application on one path, with the rest of the site public at the edge.
      </p>

      <h2>Where the links come from</h2>
      <p>
        Those two links were minted through the same API an admin uses. <Link to="/admin">The admin panel</Link> is the
        power-user side of this demo: mint a link, watch its activity, disable or revoke it, and see the session die on
        its very next request. You get a throwaway identity, and only ever see your own links — but the links you mint
        are real, and work for anyone in the world.
      </p>
      <p>
        Revocation being immediate is the load-bearing part. Grant-backed sessions re-join their grant row on{' '}
        <em>every</em> request, so a revoked link takes every session it ever minted with it. That's what makes it safe
        to assume links get forwarded: design so forwarding is visible and revocable rather than prevented, because
        prevention (one-use links, IP pinning, device binding) reliably breaks legitimate users first.
      </p>

      <h2>Two tiers, pick per app</h2>
      <div className="tiers">
        <section>
          <h3>Tier 1 — edge wall</h3>
          <p>
            Cloudflare Access <em>is</em> the wall, narrowed to gate only the data paths so the static shell and its
            og:image stay publicly crawlable. The app just reflects identity from{' '}
            <code>/cdn-cgi/access/get-identity</code>. No first-party sessions, no database, no crypto — and no share
            links. Correct when the audience is your own org plus a couple of hand-added externals.
          </p>
        </section>
        <section>
          <h3>Tier 2 — app-level authority</h3>
          <p>
            Access shrinks to just an SSO IdP on one path; everything else is public at the edge. A first-party layer
            owns auth, with HMAC session cookies and DB-backed grant tokens as <em>peers</em> — so SSO, share links,
            magic links and script tokens all land in the same place, with instant revocation and no dashboard edit per
            external. <strong>This demo is Tier 2.</strong>
          </p>
        </section>
      </div>
      <p>
        Reach for Tier 2 the moment you need share links, magic links, script tokens, or externals without a dashboard
        edit. Otherwise Tier 1. The frontend is the same either way — <code>useWhoami</code> takes the identity source as
        a parameter, so upgrading is a one-line change.
      </p>

      <h2>What's in the box</h2>
      <ul>
        <li>
          <code>core/</code> — sessions, grant tokens, scopes, redemption accounting, policy, audit. Web Crypto and a
          SQL-shaped store interface; nothing platform-specific.
        </li>
        <li>
          <code>adapters/</code> — D1 and CF Access, about forty lines each. Their peers (Postgres, Turso, Google/GitHub
          OIDC, WorkOS) are sibling files, not plugin registrations.
        </li>
        <li>
          <code>@open-athena/auth/react</code> — <code>useWhoami</code>, <code>AuthGate</code>, <code>SignInPanel</code>,{' '}
          <code>WhoamiChip</code>, and the disclosure/watermark bits. Unstyled: every string and class is a prop.
        </li>
      </ul>
      <p className="muted">
        Scope note: this is <em>gating</em> — sessions, SSO hand-off, share links, request-access, audit. It is not a
        general-purpose auth framework: no password store, no OAuth server, no RBAC engine.
      </p>

      <h2>Not acted out here</h2>
      <p>
        This page is deliberately two clicks deep. The rest of the library is real and tested, but exercising it end to
        end would need an admin inbox, an IdP, or a week of traffic — so it's described rather than demonstrated:
      </p>
      <ul className="also">
        <li>
          <strong>Approve or deny from the notification.</strong> Swap <code>anyEmailPolicy</code> for a reviewing one
          and a request stays pending: the admin address gets a mail with two buttons, the click lands on a confirm page
          (because mail scanners follow links), and a second click is a no-op that says which way it already went and
          when. <Src f="core/decisions.ts" />
        </li>
        <li>
          <strong>OIDC without Cloudflare Access.</strong> Sign in against Google or any issuer directly — same session,
          same revocation, and no Zero Trust seat per user, which is the ceiling an allowlist eventually hits.{' '}
          <Src f="adapters/oidc.ts" />
        </li>
        <li>
          <strong>Notify anywhere.</strong> Requests are one event type, not an email feature; apps wire the same sink
          to a Slack webhook, an ESP, or a <code>mailto:</code> prefill. <Src f="core/requests.ts" />
        </li>
        <li>
          <strong>An access log that answers "did Bob open this?"</strong> Every gated request is a natural emit point,
          so views join to the grant that admitted them, with self-identifying bots filtered out and view rows deduped
          per session/path/hour. <Src f="core/audit.ts" />
        </li>
        <li>
          <strong>Policy, in one function.</strong> A policy is <code>(email) =&gt; scopes | null</code> — a domain
          match, a DB-backed allowlist, or both composed — so the decision worth reviewing is one file, not a condition
          sprayed across route handlers. <Src f="core/policy.ts" />
        </li>
      </ul>
    </div>
  )
}

const REPO = 'https://github.com/Open-Athena/auth/blob/main/src/'

function Src({ f }: { f: string }) {
  return (
    <a className="src" href={`${REPO}${f}`}>
      <code>{f}</code>
    </a>
  )
}

interface SignUpResult {
  url?: string
  sent?: boolean
  email?: string
}

function SignUp() {
  const [result, setResult] = useState<SignUpResult | null>(null)
  const signUp = useMutation({
    mutationFn: (email: string) => post<SignUpResult>('/api/signup', { email }),
    onSuccess: setResult,
  })

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const email = new FormData(e.currentTarget).get('email')
    if (typeof email === 'string' && email) signUp.mutate(email)
  }

  return (
    <section className="panel">
      <h3>Sign in with an email address</h3>
      <p className="muted small">
        This demo accepts <em>any</em> address — that's a one-line policy (<code>anyEmailPolicy</code>), and a real
        deployment swaps it for a domain, an allowlist, or an approval queue. There's no password and no account row:
        the link <em>is</em> what proves the address, because it arrives in the inbox.
      </p>
      <p className="muted small">
        Mail only actually goes to a short list of domains here — a public form that emails whatever address a stranger
        types is a spam cannon pointed at other people. Everyone else gets the link on screen, which proves nothing and
        is the one step a real deployment doesn't take.
      </p>
      <form className="row" onSubmit={submit}>
        <input className="input" name="email" type="email" required placeholder="you@example.com" />
        <button className="btn primary" type="submit" disabled={signUp.isPending}>
          {signUp.isPending ? 'Signing in…' : 'Send me a link'}
        </button>
      </form>
      {signUp.error && <p className="err small">{(signUp.error as Error).message}</p>}
      {result?.sent && (
        <p className="ok small">
          Sent to <strong>{result.email}</strong> — check your inbox. That link is the proof of address; nothing was
          shown here on purpose.
        </p>
      )}
      {result?.url && (
        <p className="ok small">
          Your link: <a href={result.url}>{result.url}</a>{' '}
          <span className="muted">(shown here because this address isn't on the demo's mail list)</span>
        </p>
      )}
    </section>
  )
}

function DemoLinks() {
  const [links, setLinks] = useState<Record<string, string>>({})
  const mint = useMutation({
    mutationFn: (named: boolean) => post<{ url: string; named: boolean }>('/api/demo-link', { named }),
    onSuccess: r => setLinks(l => ({ ...l, [String(r.named)]: r.url })),
  })

  return (
    <section className="panel">
      <h3>Or open a link someone minted for you</h3>
      <p className="muted small">
        Two links to the same page. One knows who it was minted for; the other doesn't. Open both and compare what the
        page says about you — that difference is the entire social design of share links, and it's cheaper than any
        attempt to stop forwarding.
      </p>
      <div className="cards">
        {[
          { named: true, title: 'A link for Mona Octocat', blurb: 'Carries a name and a face. The page greets her, the watermark repeats her name, and the log records it. Awkward to forward.' },
          { named: false, title: 'An anonymous link', blurb: 'Carries nothing. Whoever holds it is "whoever holds it" — and forwarding costs the sender nothing at all.' },
        ].map(({ named, title, blurb }) => (
          <div key={title} className="card">
            <h3>{title}</h3>
            <p>{blurb}</p>
            {links[String(named)] ? (
              <p className="ok small">
                <a href={links[String(named)]}>Open it →</a>
              </p>
            ) : (
              <button className="btn" type="button" disabled={mint.isPending} onClick={() => mint.mutate(named)}>
                Mint one
              </button>
            )}
          </div>
        ))}
      </div>
      <p className="muted small">Both expire in an hour, and neither limits how many people can open it.</p>
    </section>
  )
}
