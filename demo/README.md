# `@open-athena/auth` demo

A live Tier-2 deployment of the package: Cloudflare Pages + Functions + D1. Intended home: **auth.oa.dev**.

Three pages:

| Path | What it shows |
|---|---|
| `/` | The ways in: the library's `SignInPanel` (Google One Tap + redirect, an emailed code / magic link), and — more prominently — two share links you can just click |
| `/dashboard` | The gated page. The wall in front of it, then a page whose only content is what the gate knows about you |
| `/admin` | The power-user side, in a throwaway sandbox: mint links, watch their log, disable / rotate / revoke them, edit an allowlist and run a (simulated) directory sync |

## The walkthrough

1. On `/`, click **A link for Mona Octocat →**, then come back and click **An anonymous link →**. Same dashboard; compare the chip (top right) and the access notice. That difference — one link is awkward to forward, the other costs nothing — is the whole social design of share links.
2. Sign out and sign in with any email address. The demo shows you the code and link it *would* have mailed (below). Enter the code, or open the link, and you're on the same dashboard as an email session.
3. Open `/admin`, start a sandbox (you get a two-word name like `brave-otter`), and mint a link. Copy it — the raw token is shown exactly once, because only its SHA-256 is stored.
4. Open it in a private window. Back in `/admin`, watch the redemption and the views appear.
5. **Disable** it (the private window keeps working — new redemptions are refused, existing sessions aren't), **Rotate** it (a new token, same terms), then **Revoke** it: the private window falls back to the wall within five seconds, without a reload.

Step 5 is the load-bearing one: grant-backed sessions re-join their grant row on every request, so revocation is instant across every session a link ever minted.

## What's real and what's simulated

**Real:** every session, token, cookie, scope check, policy and log row; the email-code mount (`emailCodeAuth`), the Google mount (`oidcStart` / `oidcCallback` / One Tap), the allowlist routes, request-access, profiles. The Functions here are what an adopter copies.

**Simulated, and labelled as such in the page:**

- **Mail.** `emailCodeAuth`'s `start` reply never says whether mail went out (so the form can't probe who's allowed), and delivery *is* the verification. This demo has no sending domain for most visitors, so its `send` captures the message instead of mailing it, stashes it in a short-lived `HttpOnly` cookie only your browser can read back (`GET /auth/email/outbox`), and the form shows you the code and link. That proves nothing about the address, and the page says so. Mail really goes out only when `RESEND_API_KEY` + `MAIL_FROM` are set *and* the recipient's domain is in `MAIL_DOMAINS` — a public form that mails whatever address a stranger types is a spam cannon pointed at other people.
- **Google.** Without `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, `/auth/google/*` answers 503, so the page drops One Tap and the Google button (and says why) rather than offering a sign-in that can't complete. Google exposes no API to create the client; `scripts/provision-oauth-client.mjs` walks the one manual step.
- **The directory sync.** `Admin → Allowlist → Sync now` `replaceSource`s `sync:staff@example.org` with a random subset of a five-person roster, returning the same `[{ group, source, count }]` shape `syncGroupsToAllowlist` returns. A real deployment puts that call at the marked spot in `functions/api/admin/[[path]].ts`, with a service-account key. The table isn't wired into any policy here (the demo admits any address) — which demonstrates a real property: mounting the editor never changes who gets in; `allowlistPolicy(store)` in the gate's `policy` is the separate line that does.

## Two gates, one grants table

`functions/_lib/gates.ts` builds two gates over the same D1 store:

- **`viewGate`** (`oa_demo_view`) — guards the dashboard. Its policy admits staff and *anyone who isn't a sandbox identity*: an email session (Google or an emailed code — both end in `gate.signIn`) re-derives its scopes from this policy on every request, so "who may sign in by email" is decided in that one line. A real deployment writes `domainPolicy`, `allowlistPolicy`, or both there.
- **`adminGate`** (`oa_demo_admin`) — guards the admin page. Staff (Google sign-ins at `STAFF_DOMAIN`, promoted from their view session by `POST /api/staff` — one registered redirect URI serves both gates) get `admin` + `requests` + `reports`; a sandbox identity gets `admin` only, so a visitor playing admin still meets the wall on the dashboard and has to mint themselves a link.

Separate cookie names let one browser hold both roles at once. The shared store is what makes revocation in one visible to the other.

The dashboard wall's request-access form posts to the *admin* mount (`/api/admin/request`): `requestAccess` auto-approves whatever a gate's policy admits, and the view gate admits everyone, so a request there would be approved and its token dropped on the floor. The admin gate doesn't admit strangers, so their requests stay pending for the staff queue. Same table, same queue.

Everything the admin mount reads or writes is filtered by `created_by`, so visitors can't see — or revoke — each other's links; another sandbox's grant id returns 404 rather than 403, so ids stay unconfirmed. The library can't scope allowlist rows the same way (the table is keyed by email, and `list()` takes no filter), so the mount wraps `d1Allowlist` in a `scopedAllowlist` that shows a visitor their own hand-added rows plus the synced group, and only removes their own. The access-request queue needs a separate `requests` scope that only staff hold, since it contains strangers' email addresses.

## Local dev

```bash
pnpm install          # from the repo root
cd demo
pnpm dev              # builds the lib, applies migrations, serves on :4187
```

Open **http://localhost:4187** — that's `wrangler pages dev`, which serves the Functions and proxies the rest to Vite on `:4188`. Hitting 4188 directly gets you the frontend with no API.

With no `SESSION_SECRET` set, a fixed dev secret is used **only** for requests to localhost; a deployed instance without one fails loudly instead. To reach the dev server from another device (e.g. `m3:4187` over Tailscale — `pnpm dev` binds all interfaces), put a `SESSION_SECRET` in `demo/.dev.vars` (git-ignored): the non-localhost hostname doesn't get the fallback, on purpose.

Migrations come straight from the package (`migrations_dir = "../migrations"`), so the demo can't drift from the schema it documents. (`schema.sql`, the one-file dump for fresh installs, lives at the package root precisely so a migration runner pointed at `migrations/` never sees it.)

## Deploying

```bash
wrangler d1 create oa-auth-demo          # paste database_id into wrangler.toml
wrangler d1 migrations apply oa-auth-demo --remote
wrangler pages secret put SESSION_SECRET # openssl rand -base64 32
pnpm deploy
```

No Cloudflare Access / Zero Trust anywhere: the whole site is public at the edge, and the gate is the app's.

Optional, each turning a simulated thing real (see `wrangler.toml` for the full list):

- `RESEND_API_KEY` + `MAIL_FROM` (`scripts/provision-resend.mjs` stores both) and `MAIL_DOMAINS` — email codes are mailed to those domains.
- `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` (`scripts/provision-oauth-client.mjs`) — Google sign-in and One Tap work.

Without any of them, `/auth/google/*` returns 503, and codes show on screen — everything else (share links, request-access, the log, the allowlist) still works.

## Caveats

- `notify` is a no-op on the admin gate: approving an access request prints the link in the page instead of emailing it. Wiring a transport is an app concern, which is the point of the hook.
- Sandbox data is never garbage-collected. A real deployment wants a retention job; see share-links-and-audit §4.
- `logViews` is **on** here because the access log is the thing being demonstrated. It defaults off in the package, and should be turned on together with the disclosure copy rather than silently.
- The outbox cookie tells your browser whether anything was sent, which a real deployment's `start` deliberately doesn't. It's scoped to `/auth/email`, `HttpOnly`, and expires with the code.
