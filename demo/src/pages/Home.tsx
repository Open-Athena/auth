import { Link } from '../router.js'

export function Home() {
  return (
    <div className="prose">
      <h1>
        <code>@open-athena/auth</code>
      </h1>
      <p className="lede">
        Share a sensitive dashboard with a named person via a link — and know what happened. Sessions and SSO are table
        stakes; the share links and the access log are the point.
      </p>

      <div className="cards">
        <Link to="/admin" className="card">
          <h3>Be the admin →</h3>
          <p>
            Get a throwaway sandbox, mint a named link, watch its activity, then revoke it. You only ever see your own
            links.
          </p>
        </Link>
        <Link to="/dashboard" className="card">
          <h3>Be the recipient →</h3>
          <p>Meet the wall: SSO for staff, request-access for everyone else, or open a link someone minted for you.</p>
        </Link>
      </div>

      <h2>The demo worth doing</h2>
      <ol>
        <li>
          Open <Link to="/admin">the console</Link> and start a sandbox.
        </li>
        <li>Mint a link named after someone. Copy it.</li>
        <li>
          Open it in a <strong>private window</strong> — you'll land on the dashboard, watermarked and told that access
          is logged.
        </li>
        <li>Back in the console, watch the redemption and views appear.</li>
        <li>
          Hit <strong>revoke</strong>, then reload the private window. The session dies on its very next request — no
          waiting out a cookie.
        </li>
      </ol>
      <p>
        That last step is the load-bearing one. Grant-backed sessions re-join their grant row on <em>every</em> request,
        so a revoked link takes every session it ever minted with it. It's what makes it safe to assume links get
        forwarded: design so forwarding is visible and revocable rather than prevented, because prevention (one-use
        links, IP pinning, device binding) reliably breaks legitimate users first.
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
    </div>
  )
}
