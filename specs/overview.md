# `@open-athena/auth`: extract the reusable auth stack (backend + FE primitives) across OA/personal apps

Goal (RW, 2026-08-12): converge the several OA/personal apps with the same "public site, gate a slice" shape onto **reusable, liftable auth layers**, extracted from the shipped implementations. Follow-on to [`auth-gate.md`][auth-gate.md] (which built watchy's app-level gate and already sketched the reuse path); triggered by [`marin-gcs-usage`] standing up its own gate (the "3rd consumer" auth-gate.md anticipated). Spec written from a marin-gcs-usage session into watchy, then seeded into this standalone repo (2026-08-13) — the extraction lives here; the canonical shipped Tier-2 code stays in watchy until re-pointed.

## Two tiers (not one pattern) — pick per app

The apps don't share *one* auth pattern; they sit at two points on a spectrum. The extraction must serve both, and make a Tier-1→Tier-2 upgrade cheap.

- **Tier 1 — edge wall.** CF Access *is* the wall, narrowed to gate only the data/API paths so the static shell (+ og:image) stays publicly crawlable for unfurls. The app just reflects identity (content vs login-wall) via `/cdn-cgi/access/get-identity`. No first-party sessions, no DB, no crypto. Authorization = "any `@openathena.ai`" + **per-person CF-dashboard whitelist**. No share links. Cheapest; correct when the audience is OA members ± a couple of hand-added externals.
  - Reference: **marin-gcs-usage** (2026-08-12) — `AuthGate` (get-identity → wall/app) + a `/login` Access-gated 302 bounce; Access narrowed to `/data*` `/v1*` `/login`.
- **Tier 2 — app-level auth authority.** CF Access shrinks to *just an SSO IdP* on one path (`/auth/sso`); everything else public at edge. A first-party layer owns auth: **HMAC session cookies + DB-backed grant tokens as peers** → SSO **and** share-links **and** magic-links **and** `Bearer`/`?key=` for scripts, with instant revocation and zero CF-dashboard edits per external.
  - Reference: **watchy** (2026-08-08, `auth-gate.md`) — the canonical, shipped Tier-2 impl.

Decision rule: reach for Tier 2 the moment you need share-links / magic-links / script tokens / externals-without-dashboard-edits. Otherwise Tier 1. marin is Tier 1 for now (audience = OA + Percy/psl, hand-whitelisted); it can upgrade later without rewriting its FE (see Layer B).

## Prior art / consumer map

Condensed from [`auth-gate.md`][auth-gate.md]'s research (see it for detail):

- **watchy** — Tier 2 reference: `cfw/src/gate.ts` (session HMAC + grants + `verifyAccessJwt`), `0007_grants.sql`, `functions/auth/sso.ts`, `functions/api/[[path]].ts` proxy, FE `www/src/auth.tsx`.
- **marin-gcs-usage** — Tier 1 reference: `site/src/AuthGate.tsx`, `site/functions/login.ts`.
- **mortgage-viz** (`$c/rac/mortgage-viz`) — origin of the *grants/nonce* substrate (`functions/_lib/doc-auth.ts`): 24-byte tokens, SHA-256-hash-only storage, per-request session→grant re-join for instant revocation. Its `specs/live-sync.md` already plans the same package split — coordinate.
- **applitrack** (`$oa/applitrack`) — a *Tier-1.5* variant: HMAC-signed session cookie (~60 lines, no lib) + **live allowlist table** checked every verify (`allowed_users`, bulk-paste admin, per-domain default roles). Useful input for the allowlist-as-DB option below.

## Layer A — `@open-athena/auth` (backend package)

Lift watchy's Tier-2 core, which is already written app-agnostic (Env deps: `DB`, `SESSION_SECRET`, `ADMIN_EMAILS`; one scope string):

- `gate.ts` — verbatim: `signSession`/`verifySession` (HMAC session cookie `{v,sub,exp}`, `sub` = `e:<email>` | `g:<id>`), `authenticate(req,env)` (cookie | `Bearer` | `?key=`, per-request grant re-check), `hasScope`, `isAdmin`, `generateToken`/`hashToken`, cookie helpers, `verifyAccessJwt` (RS256 vs team `/cdn-cgi/access/certs`).
- `0007_grants.sql` — the `grants` table (magic link ≡ grant with `email` set).
- `functions/auth/sso.ts` — Access-gated SSO→cookie bounce (verifies `Cf-Access-Jwt-Assertion`; the friendly `…-Authenticated-User-Email` header is **not** forwarded through Pages o2o).
- (watchy-only, do **not** generalize) `functions/api/[[path]].ts` — a same-origin proxy to a personal-account worker. This exists only because watchy's auth authority is a cross-account Worker. **A cleaner consumer hosts `gate.ts` directly in its Pages Functions** (marin already has `functions/data`, `functions/v1` + a D1 binding is cheap) — no separate worker, no proxy hop. The package should make "Pages-Functions-hosted" the default shape and treat "separate worker + proxy" as watchy's deployment wart.

Env contract to formalize: `{ DB: D1Database, SESSION_SECRET: string, ADMIN_EMAILS: string[], ACCESS_TEAM_DOMAIN: string, ACCESS_AUD?: string }`. Scope vocabulary is per-app (watchy uses one: `internal`).

~~Open question — **allowlist**~~ **(resolved, 2026-08-16)**: neither option is baked in. A policy is just `EmailPolicy = (email) => scopes | null`, so watchy's domain match (`domainPolicy`), applitrack's DB-backed `allowed_users` table, and any composition of them (`firstMatch`) all satisfy the same one-line contract. `adminPolicy(adminEmails)` is always checked first and grants the wildcard scope `*`. Default with no policy supplied: admins only. Policy is re-evaluated on *every* request, not just at sign-in, so narrowing it kills live SSO sessions the same way revoking a grant kills grant sessions.

## Layer B — shared FE auth primitives (React)

marin's `AuthGate`/`LoginWall` and watchy's `useWhoami`/`SignInPanel`/`WhoamiChip` are the *same UX* differing only in **identity source**: edge (`/cdn-cgi/access/get-identity`) vs app (`/api/auth/whoami`, 401→null). Extract a small **source-agnostic** module so both tiers share the UI and a Tier-1→Tier-2 swap is a one-line source change:

- `useWhoami(source)` — `source` is `{ kind: 'edge' }` (hits get-identity) or `{ kind: 'app', endpoint }` (hits a whoami API; 401→null). TSQ-backed, `staleTime` ≥5min, `retry:false`. Returns `{ whoami: T | null | undefined, refresh }` (undefined = loading).
- `<AuthGate source signIn>` — probe up front; `undefined`→nothing (brief), `null`→`<SignInPanel>`, else children. (marin's current `AuthGate` is exactly this with `kind:'edge'` inlined.)
- `<SignInPanel signInUrl hint?>` and `<WhoamiChip whoami onSignOut>` — the wall + header chip; today duplicated (`marin/AuthGate.tsx` ↔ `watchy/auth.tsx`).
- `exchangeKeyParam()` (Tier-2 only) — `?key=` → `POST /auth/exchange` → strip param via `history.replaceState`.

Styling stays per-app (className hooks, not bundled CSS). `use-prms`/`@tanstack/react-query` are peer deps (both apps already use them).

## Packaging

- **Backend**: `@open-athena/auth` — Workers/Pages-Functions TS (Web Crypto only, no Node). Home: **this repo** (`Open-Athena/auth`), consumed by SHA via [`npm-dist`] (per `pds gh`) like other OA/personal libs. Cross-dir `import` (watchy's current `../../cfw/src/gate`, esbuild-bundled) is fine as an interim before the package exists.
  - **Shipping as of 2026-08-16**: the `dist` branch is the distribution channel, and the only one until the API settles. The publish job is gated on the test job in the same workflow rather than running as a peer — consumers pin dist SHAs, so the branch must never advance past a commit whose tests failed. That's the single failure mode this model has, and it's cheap to foreclose. `pkg_exclude: pnpm` keeps the workspace's `onlyBuiltDependencies` out of the consumer-facing manifest; `type`, `exports`, `peerDependencies` and `peerDependenciesMeta` all carry over as-is.
- **FE**: either the same repo (`@open-athena/auth/react` subpath export) or a sibling `@open-athena/auth-react`. Ship as a dist-branch too.
- First real extraction = when the 2nd Tier-2 consumer appears. Until then, watchy stays the source of truth and new consumers `import` from it / copy, tracked here.

## Rollout / sequencing

**Revised 2026-08-16.** The original plan put FE primitives first ("lower risk, both apps benefit immediately") and deferred the backend to the 2nd Tier-2 consumer. [`share-links-and-audit.md`](./share-links-and-audit.md) §6 then argued the opposite emphasis — *security-critical logic packaged, presentation vendored* — which makes the FE the part that should **not** become a package, and the kernel the part that should exist before consumers accumulate divergent copies of it. So the backend went first, and it went in before the 2nd Tier-2 consumer rather than after: the marginal cost of extracting it now was one session, versus re-unifying N drifted forks later.

1. **marin** ships Tier 1 as-is (done: `AuthGate` + `/login`; pending the CF dashboard narrowing to `/data*` `/v1*` `/login`). No `@open-athena/auth` dependency yet.
2. ✅ **`@open-athena/auth` kernel** — `core/` + `adapters/{d1,cf-access}` + migrations, extracted from watchy's `gate.ts`/`0007_grants.sql`/`auth/sso.ts` and mortgage-viz's grant substrate.
3. **Re-point watchy** at the package (Pages-Functions-hosted, dropping the worker + `/api/[[path]]` proxy hop if convenient). Needs a data migration — see "Schema changes" below.
4. **FE primitives** — `useWhoami(source)`/`<AuthGate>`/`<SignInPanel>`/`<WhoamiChip>`, source-agnostic so marin passes `kind:'edge'` and watchy passes `kind:'app'`. Vendored copy-in rather than a published component package (per share-links §6); the open question is whether the *hooks* still ship as a subpath export while only the styled shells are vendored.
5. **Request-access + admin UI** — `access_requests` table, `notify(event)` hook, `/access` page.
6. If/when **marin → Tier 2**: add a D1 binding + `SESSION_SECRET`, host the gate in a Pages Function, add `/auth/sso`, swap `AuthGate` source to `kind:'app'`, and re-narrow the CF Access app from `/data*`+`/v1*`+`/login` down to just `/auth/sso`. Drop the per-person CF whitelist in favor of grant links for Stanford collaborators.

## Schema changes vs watchy's `0007_grants.sql`

The extracted `migrations/0001_grants.sql` is backwards-incompatible with the shipped watchy table; re-pointing watchy (step 3) needs a one-time migration, not a drop-in swap:

- `id`: `INTEGER AUTOINCREMENT` → random `TEXT`. Autoincrement ids in URLs and audit rows leak how many grants exist and invite guessing from a neighbour.
- Timestamps: ISO `TEXT` → epoch-seconds `INTEGER`. They compare and hour-bucket cheaply, which the access log needs.
- `label` (NOT NULL) → `name` (nullable), plus the new optional columns from share-links §1: `note`, `subject_json`, `max_redeems`, `redeems`, `session_ttl`, `first_used_at`.
- `use_count` (requests) → `redeems` (sessions minted). Different quantity, deliberately — see share-links §1.
- Session cookie name is now configurable (default `oa_auth`, watchy ships `watchy_auth`); the `{v,sub,exp}` claim shape is fixed, which answers the "standardize or shared codec?" question below as *standardize the codec, not the name*.

## Open questions

- ~~Allowlist model~~ (resolved: `EmailPolicy` hook — see Layer A).
- ~~Package home~~ (resolved: this standalone repo).
- ~~Session-cookie name / claim shape~~ (resolved: fixed `{v,sub,exp}` codec, per-app cookie name).
- FE as subpath export vs sibling package vs pure vendored copy-in — narrowed by share-links §6 but not settled for the *hooks* (as opposed to the styled shells).
- Magic-link delivery (auth-gate.md deferred real sending; `mailto:` prefill v1). Package concern or app concern? Probably the same `notify(event)` hook as request-access.

## Status

- [x] Layer A: `@open-athena/auth` kernel — sessions, grants, policy, audit, D1 + CF Access adapters, migrations
- [x] Request-access flow + `authRoutes` HTTP surface + audit read queries
- [x] Layer B: FE primitives (`@open-athena/auth/react`), unstyled; 123 tests total
- [x] `demo/` — a working Tier-2 app (Pages + Functions + D1) exercising all of the above end to end
- [x] §4 analytics: first-party beacon, bot filtering, retention rollup
- [x] Deployed at **https://auth.oa.dev** (OA CF account); GH repo `Open-Athena/auth` public, CI + `dist` branch green
- [ ] npm publish — **deliberately deferred** (RW, 2026-08-16): distribute via the `dist` branch until the API stops moving. A published npm version can only be deprecated, never taken back, so the cost of publishing early is permanent namespace clutter; a dist SHA costs nothing to abandon. Prerequisites when it's time: invite other OA members to the npm org (currently bus-factor-1, `rdub` sole owner) and pick a real semver.
- [ ] Re-point watchy at the package — **cheap**: its live `grants` table holds 2 rows, all revoked, so the BIC schema change is a drop-and-recreate, not a data migration (see [`adoption.md`](./adoption.md))
- [ ] Refactor marin's `AuthGate` onto `useWhoami({kind:'edge'})` — unblocked by `devIdentity` (see [`adoption.md`](./adoption.md))
- [ ] (marin, if it upgrades) Tier-2 migration per Rollout §6

### Deployment notes

The demo lives on the **OA** Cloudflare account (`74981a43…`), not the personal one where `watchy-www`/`mortgage-viz` live — `oa.dev` is an OA zone. `demo/scripts/oa-wrangler.sh` mirrors watchy's wrapper for this. Two snags worth recording: `wrangler pages project create` fails with a bare `Authentication error [code: 10000]` under the OA token (it calls a user-details endpoint the token can't reach) while the plain REST call works fine; and `wrangler pages deploy` ignores `wrangler.toml` entirely unless `pages_build_output_dir` is set, so the D1 binding had to be attached to the project via the API. Setting `pages_build_output_dir` in turn breaks `wrangler pages dev -- <cmd>`, which is why the deploy passes the directory on the command line instead.

The Access app is scoped to exactly `auth.oa.dev/auth/sso` with an `openathena.ai` email-domain policy, mirroring watchy's. The team domain is `openathena-ai-pages.cloudflareaccess.com` — worth pinning in writing, because the plausible-looking `openathena.cloudflareaccess.com` does not exist and a wrong `iss` fails JWT verification silently rather than loudly.

### Learned while building the demo

The demo caught a bug no unit test had: `?key=` exchange fired **twice** per link open (React StrictMode double-invokes effects, and both invocations read the token before either stripped it), so every redemption counted double. Since redemption count *is* the forwarding signal — and `max_redeems: 1` would be burned instantly — that's a correctness bug in the product's core claim, not a dev-mode annoyance. Fixed by claiming the token synchronously (read + strip before the `await`), which makes `exchangeKeyParam` self-idempotent for any caller rather than just patching the hook. Worth remembering that the shipped-app loop is what surfaced it.

Also settled by building it: two gates over one grants table (different cookie names, shared store) is a clean way to hold "admin" and "recipient" roles in one browser, and the `created_by` filter alone is enough multi-tenancy for a shared demo — no schema change needed.

[`marin-gcs-usage`]: https://github.com/Open-Athena/marin-gcs-usage
[`npm-dist`]: https://github.com/runsascoded/npm-dist
[auth-gate.md]: https://github.com/runsascoded/watchy/blob/oa/specs/auth-gate.md
