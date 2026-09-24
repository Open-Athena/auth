# Demo rebuild

Implements [`sessions-resources-idp.md` §5](sessions-resources-idp.md#5-demo-rebuild), and extends the demo to *show* what the library has shipped since that section was written: email codes / magic links (`emailCodeAuth` + `<EmailCodeForm>`), Google OIDC + One Tap, the allowlist table with directory sync (`<AllowlistPanel sync />`), self-serve profiles, and the disable / rotate verbs on a grant.

The rule throughout: the library (`src/`) does not change. Anything the demo needs and can't get from a component's props is worked around in `demo/` and recorded under **Gaps** below.

## State of play

Part of §5 already landed in earlier demo commits: `/api/demo-link` mints the two side-by-side links (named + bare), `/api/sandbox` hands out Docker-style two-word identities, the mint form says *memo* and pre-fills it, the header has a GitHub link, and the "I just opened a link — retry" button is gone. What is still missing:

- Home leads with a hand-rolled "sign in with email" form (`/api/signup`) that is request-access wearing a sign-in costume, not the library's actual sign-in surface (`SignInPanel` / `EmailCodeForm` / `GoogleOneTap`).
- The two demo links need a click on "Mint one" before they exist — §5 wants a *real clickable* link.
- Dashboard still fetches fake donor tables it then doesn't render.
- Admin still says "Console", has no allowlist, and shows only `Revoke` of the three verbs.
- Nothing shows Google sign-in, the email-code mount, or the sync route.

## Home

1. **Intro** — two sentences: what the library is, what this page lets you do.
2. **The simplest gated flow** — the library's own `SignInPanel`, composed exactly as an adopter would:
   - `googleUrl="/auth/google/start"` (redirect flow) and, above it, `<GoogleOneTap>` (in-page). Both need a Google client id; without `GOOGLE_CLIENT_ID` the mount answers 503 and One Tap falls back to a one-line note. Copy says so plainly rather than hiding the buttons.
   - `signInUrl="/auth/sso"` — the Cloudflare Access door, for staff.
   - `emailAuth` → `<EmailCodeForm>` pointed at a real mount, `demo/functions/auth/email/[[path]].ts`, copied from `examples/pages-functions/auth/email/[[path]].ts`. This demo accepts any address (qualified in copy: a real deployment restricts by domain, allowlist, or approval).
   - When someone is already signed in, this panel is replaced by a `WhoamiChip` + "go to the dashboard", so the page is coherent after a magic link opens in another tab (`useWhoami` re-probes on focus).
3. **The magic-link pitch, more prominently** — two real links side by side, `GET /api/demo-link?named=1` and `?named=0`. Each mints on click and 302s to `/dashboard?key=…`, so the page shows a link that works without anything above it, and nothing is minted for visitors who only read. One carries first/last/avatar (Mona Octocat), one carries nothing; the chip / watermark / notice difference on the dashboard is the anti-forwarding argument made visually.
4. **Admin tease** — one short paragraph and a link, not a section. "The links above came from the same API; the Admin page lets you mint your own, watch them, and revoke them."
5. **What's in the box / not acted out here** — kept but trimmed, and updated: OIDC and email codes have moved from "described" to "demonstrated"; the Google-group sync is demonstrated *simulated*; decision links from mail and SAML stay described.

### The email-code mount, honestly

`emailCodeAuth`'s `start` is deliberately constant — the response never says whether mail went out, so it can't be an allowlist oracle — and its mail goes through a `SendEmail`. The demo's `send` mails for real only when `RESEND_API_KEY` + `MAIL_FROM` are set *and* the address's domain is in `MAIL_DOMAINS` (the same spam-cannon rule the old `/api/signup` had). Otherwise it captures the code and link instead of sending, and the mount stashes them in a short-lived `HttpOnly` cookie (`oa_demo_mail`, `Path=/auth/email`, 15 min) that only that browser's `GET /auth/email/outbox` can read back. `EmailCodeForm`'s `sentHint` renders an `<Outbox>` that shows the captured mail with the existing admission: showing you the link is the one dishonest step on the page. When mail really went out, the cookie says `sent` and the outbox just says "check your inbox".

This leaks "was anything sent?" to the visitor's own browser, which a real deployment wouldn't. The copy says that too.

The magic link lands on the mount's own `verify` with `next=/dashboard`; the code path signs the session into the Home tab and navigates to the dashboard.

### Gate policy consequence

`gate.signIn` mints an *email* session, and the gate that later verifies that cookie re-derives scopes from its `policy` on every request. So for an email session to reach the dashboard, `viewGate`'s policy must admit that address: it becomes "staff, or anyone who isn't a sandbox identity". Sandbox identities live on the admin cookie and never had a view session anyway, so the sandbox-meets-the-wall behaviour is unchanged.

That has one knock-on: `viewGate.requestAccess` auto-approves whatever its policy admits, which would make the dashboard wall's request form auto-approve everyone and drop the token on the floor. So the wall's `<RequestAccessForm>` posts to `/api/admin/request` instead — the admin gate's policy is staff + sandbox, so a stranger's request stays pending for the staff queue, exactly as before. Same table, same queue, one line changed.

`/api/signup` and the hand-rolled `SignUp` component are deleted; the email-code mount is the passwordless sign-in now.

## Google

`demo/functions/auth/google/[[path]].ts` mounts `oidcStart` (`/auth/google/start`), `oidcCallback` (`/auth/google/callback`), `googleOneTapNonce` (`/auth/google/onetap/nonce`) and `googleOneTapVerify` (`/auth/google/onetap`) on `viewGate`, with `seedProfile: true` so a first Google sign-in gets a face. `GET /auth/google/client` returns the public client id (or `null`) so the page knows whether to render One Tap. Everything else 503s with a message naming `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` and pointing at `scripts/provision-oauth-client.mjs`.

## Dashboard

The gated fetch becomes `GET /api/data/private` → `{ ok, at }`: a tiny endpoint whose only job is to 401 the moment a link is revoked (polled every 5 s, `logView: false` so the poll doesn't bury the beacon's page views). The fake giving tables go.

The page is the identity placeholder §5 asks for: chip (with avatar; click it to open `<ProfilePanel>` — self-serve name and face, now that `viewGate` has a `profiles` store), the `AccessNotice`, a facts list — *which subject* (`e:<email>` or `g:<grant id>`), *how you got in* (share link vs. an email session, and for the latter that SSO, Google and an emailed code all converge on `gate.signIn`), *when it expires* — and the "sign out and come back another way" nudge with the three doors.

## Admin

- Titled **Admin** everywhere (nav already was). The sandbox name is the headline: "Sandbox `brave-otter`" rather than the raw `demo-brave-otter@sandbox.invalid`.
- Memo pre-filled with something a human would write (`<sandbox> · <time>`), no `note` field.
- A grant card grows **Disable / Enable** and **Rotate** next to **Revoke**, with one line on what each does; a rotated link's new token shows in the same once-only box.
- Copy states that links minted here are full-fidelity for anyone in the world.
- **Allowlist** — `<AllowlistPanel sync />` mounted on `authRoutes(adminGate, { allowlist, sync })`.
  - Rows can't be sandbox-scoped by the library (the table is keyed by email, and `list()` takes no filter), so the demo wraps `d1Allowlist` in a `scopedAllowlist(store, creator)` that shows a visitor their own hand-added rows plus the synced rows, and only removes rows they added. Synced rows are shared — the simulated group is one group — and the copy says so.
  - `sync.run` is a **simulated** directory sync: it `replaceSource`s `sync:staff@example.org` with a random subset of a fixed roster (so "Sync now" visibly changes the table) and returns `[{ group, source, count }]`, the same shape `syncGroupsToAllowlist` returns. Copy: "a real deployment calls `syncGroupsToAllowlist` here — see README".
  - The table is not wired into any policy in the demo (the demo admits anyone by email), and the panel says so: mounting the editor never changes who gets in; `allowlistPolicy(store)` is the separate line that does.

## README, wrangler, styles

- `demo/README.md` rewritten around the new surfaces, the new env vars (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`), and the honest-outbox behaviour.
- `wrangler.toml` comments list the new secrets.
- Library components are unstyled; `styles.scss` grows classes for the sign-in panel, email-code form, outbox, allowlist table, profile panel. Light and dark both readable.

## Gaps found in `src/` (worked around, not fixed)

- `EmailCodeForm` has no hook that sees the `start` response or the pending `id`, so an app can't surface delivery status (or drive `poll`) from it. The demo goes around it with the outbox cookie + `sentHint`. A small `onStarted?: (res: { id: string; email: string }) => void` prop would remove the workaround.
- `SignInPanel` has no slot *beside* the Google button, so One Tap renders above the panel rather than inside it.
- `AllowlistStore.list()` takes no filter and `authRoutes` scopes grants but not allowlist rows by creator, so per-sandbox isolation needs the wrapper store above.
