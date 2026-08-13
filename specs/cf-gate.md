# `cf-gate`: extract the reusable auth stack (backend + FE primitives) across OA/personal apps

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

## Layer A — `cf-gate` (backend package)

Lift watchy's Tier-2 core, which is already written app-agnostic (Env deps: `DB`, `SESSION_SECRET`, `ADMIN_EMAILS`; one scope string):

- `gate.ts` — verbatim: `signSession`/`verifySession` (HMAC session cookie `{v,sub,exp}`, `sub` = `e:<email>` | `g:<id>`), `authenticate(req,env)` (cookie | `Bearer` | `?key=`, per-request grant re-check), `hasScope`, `isAdmin`, `generateToken`/`hashToken`, cookie helpers, `verifyAccessJwt` (RS256 vs team `/cdn-cgi/access/certs`).
- `0007_grants.sql` — the `grants` table (magic link ≡ grant with `email` set).
- `functions/auth/sso.ts` — Access-gated SSO→cookie bounce (verifies `Cf-Access-Jwt-Assertion`; the friendly `…-Authenticated-User-Email` header is **not** forwarded through Pages o2o).
- (watchy-only, do **not** generalize) `functions/api/[[path]].ts` — a same-origin proxy to a personal-account worker. This exists only because watchy's auth authority is a cross-account Worker. **A cleaner consumer hosts `gate.ts` directly in its Pages Functions** (marin already has `functions/data`, `functions/v1` + a D1 binding is cheap) — no separate worker, no proxy hop. The package should make "Pages-Functions-hosted" the default shape and treat "separate worker + proxy" as watchy's deployment wart.

Env contract to formalize: `{ DB: D1Database, SESSION_SECRET: string, ADMIN_EMAILS: string[], ACCESS_TEAM_DOMAIN: string, ACCESS_AUD?: string }`. Scope vocabulary is per-app (watchy uses one: `internal`).

Open question — **allowlist**: watchy hardcodes "`@openathena.ai` OR admin". applitrack's DB-backed `allowed_users` (live-checked, bulk-paste admin, per-domain roles) is more flexible for externals-as-first-class. Decide whether `cf-gate` bakes in domain-match only, or an optional `allowlist` table + hook.

## Layer B — shared FE auth primitives (React)

marin's `AuthGate`/`LoginWall` and watchy's `useWhoami`/`SignInPanel`/`WhoamiChip` are the *same UX* differing only in **identity source**: edge (`/cdn-cgi/access/get-identity`) vs app (`/api/auth/whoami`, 401→null). Extract a small **source-agnostic** module so both tiers share the UI and a Tier-1→Tier-2 swap is a one-line source change:

- `useWhoami(source)` — `source` is `{ kind: 'edge' }` (hits get-identity) or `{ kind: 'app', endpoint }` (hits a whoami API; 401→null). TSQ-backed, `staleTime` ≥5min, `retry:false`. Returns `{ whoami: T | null | undefined, refresh }` (undefined = loading).
- `<AuthGate source signIn>` — probe up front; `undefined`→nothing (brief), `null`→`<SignInPanel>`, else children. (marin's current `AuthGate` is exactly this with `kind:'edge'` inlined.)
- `<SignInPanel signInUrl hint?>` and `<WhoamiChip whoami onSignOut>` — the wall + header chip; today duplicated (`marin/AuthGate.tsx` ↔ `watchy/auth.tsx`).
- `exchangeKeyParam()` (Tier-2 only) — `?key=` → `POST /auth/exchange` → strip param via `history.replaceState`.

Styling stays per-app (className hooks, not bundled CSS). `use-prms`/`@tanstack/react-query` are peer deps (both apps already use them).

## Packaging

- **Backend**: `cf-gate` — Workers/Pages-Functions TS (Web Crypto only, no Node). Home: **this repo** (`runsascoded/cf-gate`), consumed by SHA via [`npm-dist`] (per `pds gh`) like other OA/personal libs. Cross-dir `import` (watchy's current `../../cfw/src/gate`, esbuild-bundled) is fine as an interim before the package exists.
- **FE**: either the same repo (`cf-gate/react` subpath export) or a sibling `cf-gate-react`. Ship as a dist-branch too.
- First real extraction = when the 2nd Tier-2 consumer appears. Until then, watchy stays the source of truth and new consumers `import` from it / copy, tracked here.

## Rollout / sequencing

1. **marin** ships Tier 1 as-is (done: `AuthGate` + `/login`; pending the CF dashboard narrowing to `/data*` `/v1*` `/login`). No `cf-gate` dependency yet.
2. **FE primitives** extracted first (lower risk, both apps benefit immediately): refactor marin's `AuthGate` and watchy's `auth.tsx` onto `useWhoami(source)`/`<AuthGate>`/`<SignInPanel>`/`<WhoamiChip>`. marin passes `kind:'edge'`; watchy passes `kind:'app'`.
3. **`cf-gate` backend** extracted when a 2nd Tier-2 consumer lands (marin's own Tier-2 upgrade, or mortgage-viz's split). At that point: lift `gate.ts` + `0007_grants.sql` + `auth/sso.ts` into the package (Pages-Functions-hosted default), and re-point watchy + the new consumer at it.
4. If/when **marin → Tier 2**: add a D1 binding + `SESSION_SECRET`, host `gate.ts` in a Pages Function, add `/auth/sso`, swap `AuthGate` source to `kind:'app'`, and re-narrow the CF Access app from `/data*`+`/v1*`+`/login` down to just `/auth/sso`. Drop the per-person CF whitelist in favor of grant links for Stanford collaborators.

## Open questions

- Allowlist model (domain-only vs DB table + hook) — see Layer A.
- ~~Package home~~ (resolved: this standalone repo); FE as subpath export vs sibling package.
- Magic-link delivery (auth-gate.md deferred real sending; `mailto:` prefill v1). Package concern or app concern?
- Do we standardize the session-cookie name / claim shape across apps (watchy: `watchy_auth`, `{v,sub,exp}`), or keep per-app with shared codec?

## Status

- [ ] Layer B: extract FE primitives; refactor marin + watchy onto them
- [ ] Layer A: `cf-gate` package (on 2nd Tier-2 consumer); re-point watchy
- [ ] Decide allowlist model + packaging home
- [ ] (marin, if it upgrades) Tier-2 migration per Rollout §4

[`marin-gcs-usage`]: https://github.com/Open-Athena/marin-gcs-usage
[`npm-dist`]: https://github.com/runsascoded/npm-dist
[auth-gate.md]: https://github.com/runsascoded/watchy/blob/oa/specs/auth-gate.md
