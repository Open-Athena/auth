import { type AppWhoami, WhoamiChip, useWhoami } from '@open-athena/auth/react'
import { VIEW_SOURCE } from '../api.js'
import { Link, useNavigate } from '../router.js'
import { SignIn } from '../SignIn.js'

export function Home() {
  const navigate = useNavigate()
  const { whoami, refresh } = useWhoami<AppWhoami>(VIEW_SOURCE)

  return (
    <div className="prose">
      <h1>
        <code>@open-athena/auth</code>
      </h1>
      <p className="lede">
        Named share links, SSO, and an access log for gated pages. A gate you mount in a Cloudflare Pages Function (or
        any Worker), and unstyled React primitives for the wall in front of it. This site is the library running:{' '}
        <Link to="/dashboard">the dashboard</Link> is gated, and below are the ways in.
      </p>

      <section className="panel">
        <h2>Sign in</h2>
        <p className="muted small">
          The library's <code>SignInPanel</code>, composed the way an app would: Google (One Tap in the page, or a
          redirect), Cloudflare Access for staff, and an emailed code for everyone else. All three end in one{' '}
          <code>gate.signIn</code>. This demo admits <em>any</em> address — that's one line of policy — where a real
          deployment restricts by domain, an allowlist table, or an approval queue.
        </p>
        {whoami === undefined ? (
          <p className="muted">Checking…</p>
        ) : whoami ? (
          <SignedIn whoami={whoami} />
        ) : (
          <SignIn
            title={null}
            onSignedIn={() => {
              refresh()
              navigate('/dashboard')
            }}
          />
        )}
      </section>

      <section className="panel featured">
        <h2>Or skip all of that: open a link</h2>
        <p>
          A share link is a credential in a URL. Whoever opens it is in — no account, no sign-in page. Here are two
          links to the same dashboard; the difference between them is the whole design:
        </p>
        <div className="cards">
          <a className="card" href="/api/demo-link?named=1">
            <h3>A link for Mona Octocat →</h3>
            <p>
              Carries a name and a face. The page greets her, the watermark repeats her name across it, and the log
              records her. Awkward to forward.
            </p>
          </a>
          <a className="card" href="/api/demo-link?named=0">
            <h3>An anonymous link →</h3>
            <p>Carries nothing. Whoever holds it is "whoever holds it", and forwarding costs the sender nothing at all.</p>
          </a>
        </div>
        <p className="muted small">
          Each click mints a fresh link (an hour long, unlimited opens) and lands you on <code>/dashboard?key=…</code>.
          Open them in a private window if you'd rather keep your current session. Only the link's SHA-256 is stored,
          so the page you land on is the only place the token ever appears — and that's what makes forwarding{' '}
          <em>visible and revocable</em> rather than prevented, which is the design: one-use links, IP pinning and
          device binding reliably break legitimate users first.
        </p>
      </section>

      <h2>Where links come from</h2>
      <p>
        Both of those came from the same API an admin uses. <Link to="/admin">Admin</Link> is the power-user side: a
        throwaway sandbox where you mint your own links, watch their access log, disable, rotate or revoke them, and
        see a session die on its very next request. Links you mint there are real, for anyone in the world.
      </p>

      <h2>What's in the box</h2>
      <ul>
        <li>
          <code>core/</code> — sessions, grant tokens, scopes, redemption accounting, policy, request-access, email
          codes, audit. Web Crypto and a SQL-shaped store interface; nothing platform-specific.
        </li>
        <li>
          <code>adapters/</code> — D1, Cloudflare Access, any OIDC issuer (Google preset, plus One Tap), Resend, and a
          Google Directory group sync. Sibling files, not plugin registrations.
        </li>
        <li>
          <code>@open-athena/auth/react</code> — <code>useWhoami</code>, <code>AuthGate</code>,{' '}
          <code>SignInPanel</code>, <code>EmailCodeForm</code>, <code>GoogleOneTap</code>, <code>WhoamiChip</code>,{' '}
          <code>ProfilePanel</code>, <code>AllowlistPanel</code>, <code>RequestAccessForm</code>, <code>Avatar</code>,
          and the disclosure/watermark bits. Unstyled: every string and class is a prop.
        </li>
        <li>
          <code>scripts/</code> — provisioning for the two things with no API of their own: the Google OAuth client
          and a Resend sending domain, plus a checker for the group-sync service account.
        </li>
      </ul>
      <p className="muted">
        Scope note: this is <em>gating</em> — sessions, SSO hand-off, share links, request-access, audit. It is not a
        general-purpose auth framework: no password store, no OAuth server, no RBAC engine.
      </p>

      <h2>Not acted out here</h2>
      <p className="muted small">
        Real and tested, but exercising it end to end would need an admin inbox or a Google Workspace — so described
        rather than demonstrated:
      </p>
      <ul className="also">
        <li>
          <strong>Approve or deny from the notification.</strong> A pending request mails the admin address two
          buttons; the click lands on a confirm page (because mail scanners follow links), and a second click is a
          no-op that says which way it already went. <Src f="core/decisions.ts" />
        </li>
        <li>
          <strong>A real directory sync.</strong> Admin runs a <em>simulated</em> one into the allowlist table; the
          real call is <code>syncGroupsToAllowlist</code> with a service-account key, on a cron or the same{' '}
          <code>/allowed/sync</code> route. <Src f="adapters/google-directory.ts" />
        </li>
        <li>
          <strong>Notify anywhere.</strong> Requests are one event type, not an email feature; apps wire the same sink
          to a Slack webhook, an ESP, or a <code>mailto:</code> prefill. <Src f="core/requests.ts" />
        </li>
      </ul>
    </div>
  )
}

function SignedIn({ whoami }: { whoami: AppWhoami }) {
  return (
    <div className="signed-in">
      <WhoamiChip
        whoami={whoami}
        avatar
        logoutEndpoint="/api/view/logout"
        classNames={{ root: 'chip', name: 'chip-name', button: 'btn small', avatar: 'avatar' }}
      />
      <Link to="/dashboard" className="btn primary">
        Open the dashboard →
      </Link>
      <p className="muted small">You're already in. Sign out to try another door.</p>
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
