# `@open-athena/auth`

> Named share links, SSO, and an access log for gated dashboards.

Reusable auth layers for apps with the "public site, gate a slice" shape: a backend kernel (HMAC sessions + DB-backed grant tokens, an SSO IdP adapter) and source-agnostic React FE primitives (`useWhoami` / `AuthGate` / `SignInPanel` / `WhoamiChip`).

Mint a link, name it after the person you're sending it to, set how many times and how long it works, and see what they looked at. SSO for staff; request-access for everyone else.

Extraction target for the shipped implementations in [watchy] (Tier-2 reference), [marin-gcs-usage] (Tier 1), [mortgage-viz] (grants/nonce substrate), and applitrack (allowlist table).

Scope note: this is *gating* — sessions, SSO hand-off, share links, request-access, audit — not a general-purpose auth framework (no password store, no OAuth server, no RBAC engine).

## Try it: **[auth.oa.dev](https://auth.oa.dev)**

Get a throwaway sandbox, mint a named link, open it, watch its access log fill in — then revoke it and watch the session die on its next request. No account needed.

![@open-athena/auth](demo/public/og.jpg)

## Status

Backend kernel, request-access, the HTTP route surface, the React primitives, and the §4 analytics work (beacon, bot filtering, retention rollup) are **implemented and covered by 231 tests**, and deployed at [auth.oa.dev](https://auth.oa.dev). First adopter — [watchy](https://github.com/runsascoded/watchy), the code this was extracted from — is live on it; see `specs/adoption.md` for who's next.

- [`demo/`](demo/) — the deployed app: mint a link, watch its access log, revoke it and see the session die
- [`specs/adoption.md`](specs/adoption.md) — which repos should adopt this, in what order, and what each costs
- [`specs/overview.md`](specs/overview.md) — two-tier model, layer split, packaging
- [`specs/share-links-and-audit.md`](specs/share-links-and-audit.md) — share-link config, request-access, access log, analytics

## Layout

`core/` is runtime-agnostic — Web Crypto and a SQL-shaped store interface, nothing else. The Cloudflare coupling is exactly two adapters, kept as a *file boundary* rather than an abstraction layer (no plugin registry, no DI):

```
src/core/       sessions, tokens, grants, policy, requests, audit, routes — no CF, no Node
src/adapters/   d1.ts (grant + request stores, audit sink & queries), cf-access.ts (SSO IdP)
src/react/      useWhoami / AuthGate / SignInPanel / WhoamiChip / Avatar / disclosure — unstyled
src/testing/    in-memory stores, so adopters can test a gated route without a DB
migrations/     grants, access_log, access_requests, access_log_daily, dedupe index, request subject
demo/           a working Tier-2 app on Pages + Functions + D1
```

Peers of `adapters/d1` are any SQLite (Turso, better-sqlite3) or Postgres; peers of `adapters/cf-access` are Google/GitHub OIDC, WorkOS, or no IdP at all. Every current consumer is on CF, so those stay the only two adapters until a non-CF consumer appears.

## Installing

Not on npm yet — it ships as a **`dist` branch**, consumed by SHA (the [`npm-dist`] model other OA/personal libs use). npm comes once the API has stopped moving; the scope is registered and waiting.

```bash
pds gh auth            # if the dep is already pds-managed
```

or by hand, pinning a SHA rather than the branch so a consumer's build is reproducible:

```bash
SHA=$(gh api repos/Open-Athena/auth/commits/dist --jq .sha)
pnpm add "@open-athena/auth@github:Open-Athena/auth#$SHA"
```

The `dist` branch only advances on a commit whose tests passed, and CI then installs the published branch and exercises it (`scripts/verify-dist.mjs`) — so any SHA you can pin is green *as an artifact*, not just as source. It carries built JS + `.d.ts`, the migrations, and the peer-dep declarations; versions read `0.1.0-dist.<sha>`.

Peer deps are all optional and only needed for what you use: `@cloudflare/workers-types` (types only), and `react` + `@tanstack/react-query` for the `/react` subpath.

## Migrations

`migrations/` holds the schema in two forms. **A fresh database** applies `migrations/schema.sql` — the whole current schema in one file. **An existing database** applies only the numbered deltas it hasn't yet (`0001_*.sql` … `0011_*.sql`); each is an incremental step (a `CREATE` or an `ALTER`) that carries a live DB forward without dropping data, so the numbered files are the upgrade path and can't be collapsed away while any consumer is mid-sequence.

These are *reference DDL*, not drop-in files: apply them by **content**, integrated into your own migration runner and renumbered into your own sequence — don't assume the package's numbering matches yours. `schema.sql` is generated from the numbered migrations (`node scripts/gen-schema.mjs`) and a test keeps the two in lockstep, so it never drifts.

## Quickstart

Apply the migrations, then build a gate:

```ts
import { createGate, domainPolicy, hasScope } from '@open-athena/auth'
import { d1AuditSink, d1GrantStore } from '@open-athena/auth/d1'

const gate = createGate({
  store: d1GrantStore(env.DB),
  audit: d1AuditSink(env.DB),
  secret: env.SESSION_SECRET,
  adminEmails: ['boss@openathena.ai'],
  policy: domainPolicy(['openathena.ai'], ['internal']),
})

const auth = await gate.authenticate(request)
if (!auth || !hasScope(auth, 'internal')) return new Response('nope', { status: 401 })
```

`authenticate` accepts a session cookie, `Authorization: Bearer <token>`, or `?key=<token>` — the latter two let curl and scripts skip the cookie exchange.

**Share links.** Mint one, hand out the raw token exactly once (only its hash is stored), and let the browser trade it for a session:

```ts
const { grant, token } = await gate.mint({
  name: 'Bob Smith (donor)',
  scopes: ['reports'],
  expiresAt: Math.floor(Date.now() / 1000) + 30 * 86400,
  createdBy: auth.email,
})
// -> https://dash.example.org/?key=<token>

const res = await gate.redeem(token, request)   // POST /auth/exchange
if (res.ok) return new Response(null, { headers: { 'set-cookie': res.cookie } })
```

Every knob is optional; zero-config is an unlimited-use, never-expiring, unnamed link. `maxRedeems` counts **sessions minted** (≈ distinct browsers), not requests — which is what makes "one-use link" mean what a human predicts. Note that `maxRedeems: 1` is hostile UX in practice (the recipient opens it on their phone, then their laptop, and is locked out); prefer unlimited-redeem, named, logged, and revocable.

**SSO.** Point one CF Access application at `/auth/sso` and leave the rest of the site public at the edge:

```ts
import { ssoHandler } from '@open-athena/auth/cf-access'

export const onRequest = ssoHandler({ gate, teamDomain: 'https://acme.cloudflareaccess.com', aud: env.ACCESS_AUD })
```

**Or skip Access entirely.** `@open-athena/auth/oidc` signs people in against an OIDC provider directly, so the hosted chooser and its generic copy are replaced by a page you own:

```ts
import { GOOGLE, oidcCallback, oidcStart } from '@open-athena/auth/oidc'

const cfg = { gate, clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET,
              redirectUri: 'https://app.example.org/auth/google/callback' }
export const start = oidcStart(cfg)        // -> /auth/google
export const callback = oidcCallback(cfg)  // -> /auth/google/callback
```

Provisioning the Google client is the one genuinely manual step, and not for lack of trying: Google exposes **no API** to create a "Web application" OAuth client or read its secret — it's Cloud-Console-only ([`specs/done/oauth-client-iac.md`](specs/done/oauth-client-iac.md) has the full spike). So instead of a nonexistent `terraform apply`, there's [`scripts/provision-oauth-client.mjs`](scripts/provision-oauth-client.mjs), which scripts the whole envelope around that click — orients `gcloud`, prints a deep link to the create form pre-filled with the exact field values, then captures the pasted id/secret straight into your Pages secrets (never echoing the secret). Default is a dry run:

```bash
scripts/provision-oauth-client.mjs \
  --project oa-internal-450019 \
  --app-origin https://your-app.pages.dev \
  --redirect-uri https://your-app.pages.dev/auth/google/callback \
  --pages-project your-app            # add --run to actually store the secrets
```

Use **one client per deployment** (the callback `aud` names the app, so a token minted for one is inert at another). For One Tap ([`GoogleOneTap`](src/react/GoogleOneTap.tsx)), the app's origin just needs to be in the client's Authorized JavaScript origins — the CLI prints it as field 3.

Authorization-code flow, confidential clients only, nothing persisted between the two requests: `state` is HMAC'd with the gate secret and carries the `next` path plus a nonce, and the nonce is double-submitted via a short-lived cookie — without that, a signed state minted from the attacker's own sign-in is replayable against someone else's browser, and the victim ends up quietly signed in as the attacker. `GOOGLE` is a preset, not a special case; another issuer is four URLs.

A verified address that policy rejects redirects with `?denied=<email>` rather than 403ing, which is what lets an app pre-fill request-access with an address the *provider* vouched for instead of one the visitor typed.

There's also a seat argument: every Access-authenticated user consumes a Cloudflare Zero Trust seat, while share links never touch Access at all. A growing allowlist hits that ceiling; this is the way off it.

`ssoSessionHandler` is the same thing for a deployment that can mint sessions but not verify them — the auth store lives in another worker, so there's no gate to hand it. It takes `{ secret, teamDomain, aud, cookieName }` and mints for any Access-verified email; the gate that later verifies the cookie re-derives scopes from `policy` on every request, so authorization isn't being skipped, just deferred to where it can be answered.

**Revocation is instant.** Grant-backed sessions re-join their grant row on every request, so `gate.revoke(id)` kills every session that link ever minted — no waiting out a cookie TTL. That property is what makes the social story work: assume links get forwarded, and design so forwarding is *visible and revocable* rather than prevented.

**Three verbs, not one**, because "stop handing this out" and "throw everyone out" are different actions:

| | new redemptions | sessions already minted |
|---|---|---|
| `disable(id)` / `enable(id)` | ✗ | untouched — and reversible |
| `revoke(id)` | ✗ | dead on their next request, permanently |
| `expiresAt` passing | ✗ | dead, unless `expiryEndsSessions: false` |

`expiryEndsSessions` defaults to true — the data-room reading, where "expires Friday" means access ends Friday. Set it false and `expiresAt` becomes purely a redemption window, with each session then living out its own `sessionTtlS`; that's the `maxRedeems: 1` intuition generalised, where a link stops being redeemable the moment it's used without logging anybody out.

`gate.update(id, patch)` changes a link's terms after the fact — expiry, cap, TTL, memo — so extending a deadline doesn't mean minting and re-sending a second link. (`sessionTtlS` is baked into the cookie at redeem, so it only affects future redemptions.)

**The access log** is one store for auth-lifecycle events and (optionally) views, so "who viewed what" joins to `grants` natively. Lifecycle events always log; `view` events are deduped per (session, path, hour) by a partial unique index, and are **off by default** — turn them on alongside the "access is logged" disclosure copy, not silently. Client IPs are never stored, only `HMAC(ip, secret)`.

**Magic links / passwordless sign-up.** `anyEmailPolicy` auto-approves any address, mints a grant bound to it, and hands it to `notify` — which becomes a real sign-in flow once `notify` can send mail:

```ts
import { emailNotify } from '@open-athena/auth'
import { resendEmail } from '@open-athena/auth/resend'

notify: emailNotify({
  send: resendEmail({ apiKey: env.RESEND_API_KEY }),
  from: 'Reports <auth@example.org>',
  adminTo: 'boss@example.org',                                  // access-requested goes here
  linkFor: token => `https://reports.example.org/?key=${token}`,
})
```

No password store and no account table: **delivery is the verification.** A link sent to the claimed address proves mailbox control; a link handed straight back to whoever typed the address proves nothing — which is why the demo, having no ESP, is explicit that showing you the link is the one dishonest step on the page.

The `access-granted` message is the only place a token is ever rendered, and it goes to the bound address alone — not to the admin who approved it, not into a log, and not into the subject line. Denials send nothing: a denial notice confirms to a prober that the address exists and that a human looked, and carries nothing actionable for a real requester.

`SendEmail` is one method, so Postmark or SES is a sibling file rather than a refactor. (MailChannels' free Workers integration ended in 2024, so an ESP is a real dependency now.)

**Email codes** (`emailCodeAuth`) are the same delivery-is-verification idea as a sign-in rather than a sign-up: a magic link plus a 6-digit code in one mail, backed by a `pending_auth` row (`d1PendingAuthStore`), converging on the same `gate.signIn` as Google or Access. It's four mountable handlers — [`examples/pages-functions/auth/email/[[path]].ts`](examples/pages-functions/auth/email/%5B%5Bpath%5D%5D.ts) is the reference Pages-Function mount, and `<EmailCodeForm>` (or `<SignInPanel emailAuth>`) is the front half.

**Provisioning Resend.** Unlike the Google client, every step here has an API, so [`scripts/provision-resend.mjs`](scripts/provision-resend.mjs) does the whole thing: creates the sending domain in Resend, writes the SPF/DKIM records it returns onto your Cloudflare zone (idempotently — re-runs skip what's already there), kicks off verification, and stores `RESEND_API_KEY` + `MAIL_FROM` as Pages (or Worker) secrets, piping the key on stdin so it never touches argv. Dry run by default:

```bash
RESEND_API_KEY=re_… CLOUDFLARE_API_TOKEN=… scripts/provision-resend.mjs \
  --domain example.org --zone-id <zone-id> --from noreply@example.org \
  --pages-project your-app --dmarc      # add --run to apply; --wait 600 to poll verification
```

What stays manual: a Resend account and a *full-access* API key (domains are account-scoped; a send-only key can't create one), a Cloudflare token with `Zone:DNS:Edit`, accepting an ESP as a dependency, and the DNS-propagation wait — usually minutes on a Cloudflare zone, after which `--only verify --wait 600` finishes the job. The records are ordinary DNS, so teams that already run their zone as code can express the same thing in Terraform instead (`resend_domain` emits the identical `records` list; `cloudflare_dns_record` consumes it) — the script just spares everyone else a provider, a state backend, and a key in state.

**Allowlist as a table, not a redeploy.** A `policy` can be a literal (`domainPolicy`, `adminPolicy`) *or* a DB table, because `EmailPolicy` is `(email) => scopes | null | Promise<…>`. `allowlistPolicy(store)` reads an `allowed_emails` table so "who's allowed" is edited, not shipped:

```ts
import { allowlistPolicy, firstMatch, adminPolicy } from '@open-athena/auth'
import { d1Allowlist } from '@open-athena/auth/d1'

const allowlist = d1Allowlist(env.DB)
createGate({ ..., policy: firstMatch(adminPolicy(ADMINS), allowlistPolicy(allowlist)) })
authRoutes(gate, { allowlist })   // adds admin GET/POST/DELETE <base>/allowed; <AllowlistPanel/> in react/
```

Each row carries its own scopes, or pass `allowlistPolicy(store, { scopes })` to grant a fixed set to every member. Rows arrive by hand (the panel) or out of band: a directory sync owns a `source` and calls `store.replaceSource('sync:board@…', members)` — one transaction, so a sign-in mid-sync never sees the group empty and a sync never clobbers a hand-added guest. Mounting the editor doesn't change who gets in; that's the separate `policy` wiring, on purpose.

**Google groups, synced.** Google's OIDC id_token carries no Workspace group membership (by design — enterprise IdPs emit a `groups` claim; Google doesn't, over OIDC), and nothing pushes a group change to a custom app (Google's Shared Signals role is *receiver*, session-revocation only). So "gate this to `board@`" is a periodic pull into the table above, and `@open-athena/auth/google-directory` makes it one call — a service-account token minted with WebCrypto (no dependency, no `nodejs_compat`), one paginated list, one `replaceSource`:

```ts
import { syncGroupsToAllowlist } from '@open-athena/auth/google-directory'

export default {
  // wrangler.toml: [triggers] crons = ["*/15 * * * *"]
  async scheduled(_ev, env) {
    await syncGroupsToAllowlist(d1Allowlist(env.DB), {
      key: env.GOOGLE_SA_KEY,                          // the SA key JSON, as a secret
      groups: [{ group: 'board@example.org', scopes: ['board'] }],
    })
  },
}
```

Because `allowlistPolicy` is re-evaluated on every request, a removed member is denied within one sync interval — at 15 minutes, well inside the ~1 h token lifetime most orgs accept as their revocation window. `listGroupMembers`/`googleAccessToken` are exported separately for anything else that needs a group or an SA token.

**On Pages (no cron):** mount the sync as a route instead — `authRoutes(gate, { allowlist, sync: { run: () => syncGroupsToAllowlist(…), token: env.SYNC_TOKEN } })` adds `POST <base>/allowed/sync`, callable by an admin session (`<AllowlistPanel sync />` shows a "Sync now" button) or by `Authorization: Bearer <SYNC_TOKEN>`, so a scheduled GitHub Action is the whole cron:

```yaml
on: { schedule: [{ cron: '*/15 * * * *' }], workflow_dispatch: {} }
jobs:
  sync: { runs-on: ubuntu-latest, steps: [{ run: "curl -fsS -X POST -H 'Authorization: Bearer ${{ secrets.SYNC_TOKEN }}' https://your-app.pages.dev/api/auth/allowed/sync" }] }
```

A failing sync answers 502 with the error and leaves the table as it was.

Provisioning is `gcloud`, and needs **no domain-wide delegation**: the service account acts as itself once it can read the group — either as an *owner of just that group* (lightest), or holding the *Groups Reader* admin role (Admin console → *Assign service accounts*, or Terraform's `googleworkspace_role_assignment`). Whoever runs this once must be a Workspace admin or the group's owner; after that, membership is edited in Workspace and nothing here changes.

```bash
gcloud iam service-accounts create group-sync --project $PROJECT
gcloud services enable admin.googleapis.com --project $PROJECT
gcloud iam service-accounts keys create sa.json --iam-account group-sync@$PROJECT.iam.gserviceaccount.com
gcloud identity groups memberships add --group-email=board@example.org \
  --member-email=group-sync@$PROJECT.iam.gserviceaccount.com --roles=OWNER
wrangler secret put GOOGLE_SA_KEY < sa.json && rm sa.json
```

The default read is the Cloud Identity API, which is what honours a group-*owner* SA (verified against a real Workspace: the Admin SDK Directory API refuses one with "Not Authorized"). `api: 'directory'` switches to the Admin SDK — it flattens nested groups — for an SA holding the Groups Reader admin role, or with `subject: 'admin@…'` for orgs wired for domain-wide delegation. The "live, signed at each sign-in" tier — a **SAML** adapter consuming Google's group-attribute assertion — stays specced but unbuilt ([`specs/saml-groups.md`](specs/saml-groups.md)): it only refreshes at login, so it is *slower* to revoke than this sync unless it writes into the same table anyway.

**Mounting it.** `authRoutes(gate, opts)` is a whole `/api/auth/*` surface — whoami, exchange, logout, request-access, and admin grant/request/log routes — returning `null` for paths it doesn't own so your router can fall through. `creatorOf`/`scopeToCreator` confine an admin to their own grants, which is how the demo lets strangers share one deployment.

**Request access** collects an address, and optionally a person: `<RequestAccessForm askName="split" />` posts first/last, stored as the same `Subject` a grant carries — so approving mints a link that knows who it's for, and the watermark says "Ada Lovelace" rather than `ada@…`. An avatar is never *accepted* from the form (a stranger-supplied URL rendered on the admin's queue is a tracking pixel aimed at the reviewer); `<Avatar>` derives initials instead, or renders `subject.avatar` when the app sets one itself.

**On the frontend**, `@open-athena/auth/react` ships the logic and leaves the presentation to you — every string and class is a prop, and no CSS is bundled:

```tsx
<AuthGate
  source={{ kind: 'app' }}          // or { kind: 'edge' } for Tier 1 — the only line that changes
  signIn={<SignInPanel signInUrl="/auth/sso" requestAccess />}
>
  {whoami => <>
    <AccessNotice whoami={whoami} />   {/* "Private link for Bob Smith · access is logged" */}
    <Dashboard />
  </>}
</AuthGate>
```

## Development

```bash
pnpm install
pnpm test        # vitest; core runs against an in-memory store, adapters against node:sqlite
pnpm typecheck
pnpm build
cd demo && pnpm dev    # the whole thing running, on :4187
```

`pnpm build` compiles `src/core` and `src/adapters` against `@cloudflare/workers-types` alone (no Node types), which is what keeps them honest about being runtime-agnostic. `src/react` is a separate compilation because DOM lib and workers-types declare conflicting globals.

[`npm-dist`]: https://github.com/runsascoded/npm-dist
[watchy]: https://github.com/runsascoded/watchy
[marin-gcs-usage]: https://github.com/Open-Athena/marin-gcs-usage
[mortgage-viz]: https://github.com/runsascoded/mortgage-viz
