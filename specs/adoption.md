# Who should adopt this, in what order

*(RW + session, 2026-08-16. Grounded in reading each candidate's actual auth code, not the consumer map's summary of it. Written here; the per-repo work lands as `specs/*.md` in each target, per the cross-project spec workflow.)*

Ranked by (value of adopting) ÷ (cost of adopting). The short version: **watchy now, marin next, mortgage-viz only after a design decision, applitrack probably never.**

## 1. watchy — do this first

**Cost: low. Value: high (it's the code this was extracted from).**

`cfw/src/gate.ts` (186 lines), `cfw/src/auth.ts` (99), `www/functions/auth/sso.ts` (27) and `www/src/auth.tsx` (78) all collapse into package calls. The `/api/[[path]]` proxy hop can go too if the gate moves into Pages Functions, which `overview.md` already calls watchy's deployment wart.

**The migration is nearly free, which was not obvious.** The schema change *is* backwards-incompatible (random TEXT ids, epoch-second timestamps, `label`→`name`, `use_count`→`redeems`), and earlier drafts of this spec treated that as the blocker. But watchy's live `grants` table holds **2 rows, both revoked, 0 active** (checked 2026-08-16). There is nothing to preserve: drop the table, apply `0001_grants.sql`, done. Anyone still holding a watchy link already can't use it.

Behaviour differences to port deliberately, not silently:

- **Scopes.** watchy's `hasScope` returns `true` for *any* SSO identity; the package requires an explicit scope, with `*` reserved for admins. Give staff `['internal']` via `domainPolicy(['openathena.ai'], ['internal'])` and the behaviour matches.
- **Cookie name.** watchy ships `watchy_auth`; pass `cookieName: 'watchy_auth'` to keep existing SSO sessions alive across the deploy, or accept one forced re-login.
- **Per-request `use_count`.** watchy increments a counter on every request; the package counts *redemptions* (sessions minted) and touches `last_used_at` at most once a minute. That's the intended change — see share-links §1 — but the admin UI's "uses" column now means something different.

## 2. marin-gcs-usage — the Tier-1 proof

**Cost: low. Value: proves the tier-agnostic FE claim is real.**

`site/src/AuthGate.tsx` is 47 lines and does exactly what the package's `<AuthGate source={{kind:'edge'}}>` does. Adopting it is close to a delete, and it's the only way the "swapping tiers is a one-line change" claim gets tested by something other than its author.

**It needed a package change first**, now shipped: marin's gate has a dev escape (`import.meta.env.DEV` short-circuit, plus `?wall` to force the wall) because `/cdn-cgi/access/get-identity` doesn't exist locally, so every local page load would otherwise hit the wall. `useWhoami`/`<AuthGate>` now take `devIdentity` — `undefined` probes normally, a value stubs it, `null` forces the wall. The *policy* stays in the app, which is the only place that knows its own build flags:

```tsx
devIdentity={import.meta.env.DEV && !forceWall ? { email: 'dev@example.test' } : undefined}
```

Marin keeps its own `LoginWall` copy — that's the vendored half of the split, and correctly so.

No backend adoption: marin is Tier 1 and stays there until it needs share links.

## 3. mortgage-viz — blocked on a real design question

**Cost: medium-high. Value: real, but it forces an architecture decision.**

`functions/_lib/doc-auth.ts` (153 lines) is where the grant substrate came from, so the primitives fit: `generateToken`/`hashToken`, the hash-only-at-rest rule, session→grant re-join for instant revocation. Those could be adopted today.

**The grants table does not fit.** mortgage-viz is per-*document*: `docs` each with an `owner_secret_hash`, and `doc_grants` scoped to a `doc_id`, with `perms: view|edit|manage` ranked rather than a scope set. `@open-athena/auth` models *one app, gate a slice* — grants are app-wide with no resource dimension.

So the decision is: **does `grants` get an optional `resource` column?**

- **Yes** → one substrate serves both, mortgage-viz adopts wholesale, and `hasScope` grows a resource argument. Cost: complexity on every consumer that will never use it.
- **No** → mortgage-viz takes `core/tokens` + `core/session` and keeps its own store. Cost: the redemption-cap CAS and the audit log get reimplemented there, which is exactly the silent-divergence risk §6 warns about.

Leaning **no for now**, revisit at a third consumer that wants per-resource grants. Adding a column is easy later; removing a half-used abstraction is not. Its `specs/live-sync.md` already plans a substrate split, so coordinate before either side builds.

## 4. applitrack — not a candidate

**Cost: high. Value: low.**

Read `lib/session.ts` (226 lines): Next.js on Node, `better-sqlite3`, Node's `crypto` (not Web Crypto), **Google OAuth** rather than CF Access, and `Role` (`admin` | `openathena_team` | `marin_external`) rather than scopes. Adopting needs a SQLite store adapter, a Google-OIDC IdP adapter, and a role↔scope mapping — three new adapters to serve one consumer that isn't even on Cloudflare.

Its value to this project was always as *input*, not as an adopter: its live `allowed_users` table is what made the `EmailPolicy` hook take the shape it did, and `defaultRoleForEmail` is exactly a `policy` fn. That debt is already paid.

Revisit only if a second non-CF, non-Workers consumer appears — at which point the store adapter is worth writing for both.

## What was built to unblock the above

- `devIdentity` on `useWhoami`/`<AuthGate>` (marin, above).
- **`@open-athena/auth/testing`** — in-memory `GrantStore`/`RequestStore`/`AuditSink`. Every adopter needs to test a gated route, and standing up D1 to assert "a revoked link 401s" is enough ceremony that people skip the test instead. The memory store mirrors the D1 adapter's redemption-cap guard, so behaviour matches production.
- **Deny dedupe.** A revoked link's browser re-denied on *every* page load, one row each. Denials that carry a `session_sub` are now deduped per (event, session, path, hour); denials from a *presented token* are never deduped, because repeats there are someone probing — precisely the signal worth keeping. Needed `0005_dedupe_by_event.sql`, since the old index would have let a deny and a view collide.

## Still open, and worth deciding before a second Tier-2 consumer

- **Anonymous traffic isn't logged.** §4 wants middleware logging every request; today the log starts once someone has an identity, so "how much of last week was Bob vs. strangers" stays half-answered.
- **Stale cookies after expiry.** A grant's `session_ttl` and its `expires_at` are independent, so an expired grant leaves a live cookie the browser keeps sending. It fails correctly (and now quietly, post-dedupe), but clearing it on the deny path would be tidier.
- **Admin UI**: the demo's console is app-specific, which is evidence for §6's "vendor the UI" position but not yet a decision.
- **`resource` column** (mortgage-viz, above).
