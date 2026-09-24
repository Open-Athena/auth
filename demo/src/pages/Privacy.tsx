import { Link } from '../router.js'

export function Privacy() {
  return (
    <div className="prose">
      <h1>Privacy</h1>
      <p className="lede">
        This site is a public demo of <code>@open-athena/auth</code>, run by Open Athena. It keeps only what the gate
        needs to work and to show you how it works.
      </p>

      <h2>What's stored</h2>
      <ul>
        <li>
          <strong>Your email address</strong>, when you sign in with Google or an emailed code, and your name and
          profile-picture URL from Google, if you use Google.
        </li>
        <li>
          <strong>An access log</strong> of sign-ins, link redemptions and page views on the gated pages: time, path,
          country, browser user-agent, referrer, and an HMAC of your IP address (never the address itself).
        </li>
        <li>
          <strong>What you enter</strong> in the Admin sandbox (links you mint, allowlist rows) and in the
          request-access form.
        </li>
        <li>
          <strong>Cookies</strong>: a signed session cookie per gate, and, while an emailed code is pending, a
          short-lived cookie holding the message the demo shows you instead of mailing it. No analytics, no ads, no
          third-party trackers.
        </li>
      </ul>

      <h2>What it's used for</h2>
      <p>
        Running the demo: signing you in, gating the <Link to="/dashboard">dashboard</Link>, and showing the log back
        to whoever minted the link you used. Nothing is sold or shared. Google sign-in asks only for your email address
        and basic profile; the demo requests no other Google data.
      </p>

      <h2>Where and how long</h2>
      <p>
        In a Cloudflare D1 database. This is a demo, so there's no retention schedule yet: data may be wiped at any
        time, and will be deleted on request.
      </p>

      <h2>Contact</h2>
      <p>
        <a href="mailto:auth@openathena.ai">auth@openathena.ai</a> — for questions, or to have your data deleted.
      </p>
    </div>
  )
}
