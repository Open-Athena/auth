# Demo rebuild — as built

Implements [`sessions-resources-idp.md` §5](../sessions-resources-idp.md#5-demo-rebuild--built-2026-09-see-donedemo-rebuildmd), and extends the demo to *show* what the library has shipped since that section was written: email codes / magic links (`emailCodeAuth` + `<EmailCodeForm>`), Google OIDC + One Tap, the allowlist table with directory sync (`<AllowlistPanel sync />`), self-serve profiles, and the disable / rotate verbs on a grant.

The rule throughout: the library (`src/`) does not change. Anything the demo needs and can't get from a component's props is worked around in `demo/` and recorded under **Gaps** below.

## State of play before this

Part of §5 had already landed in earlier demo commits: `/api/demo-link` minted the two side-by-side links (named + bare), `/api/sandbox` handed out Docker-style two-word identities, the mint form said *memo* and pre-filled it, the header had a GitHub link, and the "I just opened a link — retry" button was gone. What was still missing:

- Home led with a hand-rolled "sign in with email" form (`/api/signup`) that was request-access wearing a sign-in costume, not the library's actual sign-in surface (`SignInPanel` / `EmailCodeForm` / `GoogleOneTap`).
- The two demo links needed a click on "Mint one" before they existed — §5 wants a *real clickable* link.
- Dashboard still fetched fake donor tables it then didn't render.
- Admin still said "Console", had no allowlist, and showed only `Revoke` of the three verbs.
- Nothing showed Google sign-in, the email-code mount, or the sync route.

## Home (`demo/src/pages/Home.tsx`, `demo/src/SignIn.tsx`)

1. **Intro** — two sentences: what the library is, what this page lets you do.
2. **Sign in** — the library's own `SignInPanel`, composed exactly as an adopter would (`SignIn.tsx`, shared with the dashboard wall):
   - `<GoogleOneTap>` above it (in-page), `googleUrl="/auth/google/start?next=/dashboard"` (redirect) inside it. Both need a Google client id; the page asks `GET /auth/google/client` and, when it answers `null`, renders a one-line note saying the buttons are inert and why (Google has no API to create the client; `scripts/provision-oauth-client.mjs` walks the manual step). The buttons stay visible.
   - `signInUrl="/auth/sso?next=/dashboard"` — the Cloudflare Access door, for staff.
   - `emailAuth` → `<EmailCodeForm>` pointed at the real mount `demo/functions/auth/email/[[path]].ts`, copied from `examples/pages-functions/auth/email/[[path]].ts`. Copy qualifies: this demo accepts any address; a real deployment restricts by domain, allowlist, or approval.
   - When someone is already signed in (`useWhoami` on the same source the dashboard uses), the panel is replaced by a `WhoamiChip` + "Open the dashboard →", so the page is coherent after a magic link opens in another tab (`useWhoami` re-probes on focus while signed out).
3. **The magic-link pitch, in an accent-bordered panel** — two real links side by side, `GET /api/demo-link?named=1` and `?named=0`. Each mints on click and 302s to `/dashboard?key=…`: the page shows a link that simply works without anything above it, and nothing is minted for visitors who only read. One carries first/last/avatar (Mona Octocat, GitHub face resolved server-side), one carries nothing.
4. **Admin tease** — one paragraph and a link.
5. **What's in the box** updated (OIDC/One Tap, Resend, Google Directory, the new React components, the provisioning scripts); **Not acted out here** trimmed to decision links, a *real* directory sync, and notify-anywhere.

### The email-code mount, honestly

`emailCodeAuth`'s `start` is deliberately constant — the response never says whether mail went out, so it can't be an allowlist oracle — and its mail goes through a `SendEmail`. The demo's `send` mails for real only when `RESEND_API_KEY` + `MAIL_FROM` are set *and* the address's domain is in `MAIL_DOMAINS` (the same spam-cannon rule the old `/api/signup` had; `mailable()` moved to `_lib/gates.ts`). Otherwise it captures the code and link instead of sending, and the mount stashes them in a short-lived `HttpOnly` cookie (`oa_demo_mail`, `Path=/auth/email`, 15 min) that only that browser's `GET /auth/email/outbox` reads back. `EmailCodeForm`'s `sentHint` renders an `<Outbox>` that fetches it and shows the captured mail with the existing admission: showing you the link is the one dishonest step on the page. When mail really went out the cookie says `sent` and the outbox says "check your inbox"; when nothing was sent (rate-limited, or a `sandbox.invalid` address) it says so.

This leaks "was anything sent?" to the visitor's own browser, which a real deployment wouldn't. The copy says that too.

`send` is called synchronously inside `start` (before it resolves), so the capture is settled by the time the mount appends the cookie — even though delivery itself goes through `waitUntil`.

The magic link lands on the mount's own `verify` with `next=/dashboard`; the code path signs the session into the Home tab, refreshes whoami, and navigates to the dashboard.

### Gate policy consequence (`demo/functions/_lib/gates.ts`)

`gate.signIn` mints an *email* session, and the gate that later verifies that cookie re-derives scopes from its `policy` on every request. So for an email session to reach the dashboard, `viewGate`'s policy must admit that address: it is now `firstMatch(domainPolicy([staff]), anyoneButSandbox)`. Sandbox identities live on the admin cookie and never had a view session anyway, so the sandbox-meets-the-wall behaviour is unchanged. `viewGate` also gets `profiles: d1ProfileStore(env.DB)` so the chip can open `<ProfilePanel>`.

Knock-on: `requestAccess` auto-approves whatever a gate's policy admits, which would make the dashboard wall's request form auto-approve everyone and drop the token on the floor. So the wall's `<RequestAccessForm>` posts to `/api/admin/request` — the admin gate's policy is staff + sandbox, so a stranger's request stays pending for the staff queue, exactly as before. Same table, same queue, one endpoint string changed.

`/api/signup` and the hand-rolled `SignUp` component are deleted; the email-code mount is the passwordless sign-in now.

## Google (`demo/functions/auth/google/[[path]].ts`)

Mounts `oidcStart` (`/auth/google/start`), `oidcCallback` (`/auth/google/callback`), `googleOneTapNonce` (`/auth/google/onetap/nonce`) and `googleOneTapVerify` (`/auth/google/onetap`) on `viewGate`, with `seedProfile: true`. `GET /auth/google/client` returns the public client id (or `null`). Everything else 503s with a message naming `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` and pointing at `scripts/provision-oauth-client.mjs`. Not exercised against Google here (no client); the handlers are the library's, so the mount is wiring only.

## Dashboard (`demo/src/pages/Dashboard.tsx`)

The gated fetch is now `GET /api/data/private` → `{ ok, at }`: its only job is to 401 the moment a link is revoked. Polled every 5 s with `logView: false` so the poll doesn't bury the beacon's page views. The fake giving tables are gone (`api.summary`, `money`, `Summary` removed from `api.ts`).

The page is the identity placeholder §5 asks for: chip with avatar (click it, on an email session, to open `<ProfilePanel endpoint="/api/view/profile">`), the `AccessNotice`, a big facts list — *subject* (`e:<email>` or `g:<grant id>`), *how you got in* (a share link vs. an email session — SSO, Google and an emailed code all end in `gate.signIn` and the gate can't tell them apart), *known as*, scopes, *expires* — and the "come back another way" nudge with the three doors. The wall is `SignIn` + a `<details>` holding request-access.

## Admin (`demo/src/pages/Admin.tsx`, `demo/functions/api/admin/[[path]].ts`)

- Titled **Admin** everywhere. The sandbox name is the headline: "Sandbox `brave-otter` — throwaway, and yours alone".
- Memo pre-filled with `<sandbox> · <time>`; the field is named `memo` on the form, still posted as the library's `name`. No `note` field.
- A grant card has **Disable / Enable**, **Rotate** and **Revoke**, with a line on what each does; a rotated link's new token shows in the same once-only box. "No memo" rather than "Unnamed link"; a subject is shown as "for Ada Lovelace".
- Copy states that links minted here are full-fidelity for anyone in the world.
- **Allowlist** — `<AllowlistPanel sync />` mounted on `authRoutes(adminGate, { allowlist, sync })`.
  - Rows can't be sandbox-scoped by the library (the table is keyed by email, and `list()` takes no filter), so the mount wraps `d1Allowlist` in `scopedAllowlist(store, creator)`: a visitor lists their own hand-added rows (`addedBy === creator`) plus the synced rows, and `remove` refuses rows they don't own. The mount authenticates once itself, only for `/api/admin/allowed*`, to learn the creator before `authRoutes` runs. Synced rows are shared — the simulated group is one group — and two visitors adding the same address share one row; the copy says so.
  - `sync.run` is a **simulated** directory sync: it `replaceSource`s `sync:staff@example.org` with a random 2–5 member subset of a fixed five-name roster (so "Sync now" visibly changes the table) and returns `[{ group, source, count }]`, the same shape `syncGroupsToAllowlist` returns. Copy: "a real deployment calls `syncGroupsToAllowlist` here — see README", and the code comment shows the call.
  - The table is not wired into any policy in the demo (the demo admits anyone by email), and the panel says so: mounting the editor never changes who gets in; `allowlistPolicy(store)` is the separate line that does.

## Migrations: a pre-existing breakage, worked around in the demo

`pnpm dev` didn't boot on a fresh local DB before any of this: `demo/wrangler.toml` pointed `migrations_dir` straight at the package's `migrations/`, which since `7267e66` also contained `schema.sql`, and wrangler applies every `.sql` it finds — so after `0012_*` it applied `schema.sql` and died on `table grants already exists`. (Any consumer pointing a migration runner at the package directory, and the deployed demo DB via `db:remote`, would have hit the same.)

**Fixed at the package level** (`ca3f3e1`, folded in before merge): `schema.sql` moved to the package root (`files` + a `./schema.sql` export; `gen-schema`, the lockstep test, README and `verify-dist` follow), and the demo's interim symlink workaround (`demo/migrations/` + `scripts/link-migrations.sh`) was dropped — `migrations_dir = "../migrations"` again.

## README, wrangler, styles

- `demo/README.md` rewritten: the three pages, a walkthrough that starts with the clickable links and ends with disable → rotate → revoke, a "real vs. simulated" section, the two-gates explanation updated for the policy change and the request-access routing, the new optional secrets, the migrations note.
- `wrangler.toml` comments list every secret; `index.html` descriptions mention the new doors.
- `styles.scss`: classes for `SignInPanel` / `EmailCodeForm` (`.signin-panel`, `.divider`, `.hint`), the One Tap slot, the inert note, the outbox and its big code, the signed-in row, the featured panel, anchor cards, the chip's profile button, the big facts list, and the allowlist table. Dead `.totals` / `.stat` styles removed. Tokens are the existing light/dark pairs.

## Verified

`pnpm -w run build`, `pnpm -w run typecheck`, `pnpm -w test` (402 tests), `cd demo && pnpm typecheck && pnpm build` all pass. Against `pnpm dev` on :4187 with curl: `/` 200; `/api/view/whoami` 401; `/auth/google/client` → `{clientId: null}`, `/auth/google/start` 503 with the message; `/api/demo-link?named=1` 302 → `/dashboard?key=…`; email start → constant `{status:'sent', id}` + outbox cookie → outbox shows code + link; wrong code 400, right code 200 + session, replay 400; magic link 302 → `/dashboard` with an email session holding `reports`; a `sandbox.invalid` address gets the constant reply and an outbox saying nothing was sent; `PUT /api/view/profile` on an email session; two sandboxes each see the synced rows and only their own manual row, and can't remove each other's; `POST /allowed/sync` 401 anonymous; `/api/admin/request` → `pending`; mint → exchange → `/api/data/private` 200 → disable (still 200) → rotate → revoke → 401 on the next request, with the log showing `mint, redeem, disable, rotate, revoke, deny`.

Not verified here: the rendered UI in a browser (the user does that), and the Google handlers against a real client.

## Gaps found in `src/` (worked around, not fixed)

- `EmailCodeForm` has no hook that sees the `start` response or the pending `id`, so an app can't surface delivery status (or drive `poll`) from it. The demo goes around it with the outbox cookie + `sentHint`. A small `onStarted?: (res: { id: string; email: string }) => void` prop would remove the workaround.
- `SignInPanel` has no slot *beside* the Google button, so One Tap renders above the panel rather than inside it.
- `AllowlistStore.list()` takes no filter and `authRoutes` scopes grants but not allowlist rows by creator, so per-sandbox isolation needs the wrapper store above.
- ~~`migrations/schema.sql` living inside `migrations/` breaks any consumer that points a migration runner at that directory~~ — fixed upstream (`ca3f3e1`).
