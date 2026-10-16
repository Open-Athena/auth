# Sessions, resources, and not becoming an IdP

Decisions from the 2026-08-19/21 thread, for the work that isn't built yet. The link-lifecycle half (`disable`/`enable`/`update`, `expiryEndsSessions`) shipped in `d886126`; this is what's left, in the order I'd build it.

## 1. A session registry, optional

`specs/auth-upstream-followups.md` §7 argued against this on the grounds that it costs a DB read per authenticated request. That argument was wrong twice over — grant sessions already do one (the re-join *is* instant revocation), and the `not-before` alternative needs the same read — and the ask that survives it is real: list active sessions, revoke one device, see last-seen.

**Shape.** `sessions?: SessionStore` on `GateOptions`. Absent, everything behaves exactly as it does today and SSO sessions stay stateless. Present, the claim carries a `sid`, and:

```sql
CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,
  sub         TEXT NOT NULL,      -- e:<email> | g:<grant_id>
  grant_id    TEXT,               -- FK when derived from a link; NULL for SSO
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at  INTEGER,
  ip_hash     TEXT,               -- HMAC, as everywhere else
  user_agent  TEXT
);
```

Pay-for-what-you-use is the whole point: an app that wants share links and nothing else shouldn't inherit a table it has to garbage-collect.

**What it buys, beyond listing.** `sessionTtlS` is baked into the cookie at redeem, so `update()` changing it today only affects *future* redemptions. Preserve that contract when introducing the registry: a separate explicit session-expiry/revocation operation may shorten existing rows, but editing a grant's session TTL must not silently rewrite them. `expiryEndsSessions` is already checked live in `core/gate.ts` by `sessionValid()` on every grant-session request; flipping it after minting already affects existing sessions without a registry. The registry adds per-session expiry/revocation control, not that existing grant-lifecycle behavior.

**Costs to be honest about.** SSO sessions become stateful (one read per request, cacheable with a short TTL at the cost of a bounded delay on revocation). Rows need expiring. And the registry can disagree with a validly-signed cookie — the rule should be that the registry wins, since that's the entire reason it exists.

### Phase-1 registry and retained-login contract (implementation started, 2026-10-16)

The table above is a registry-only sketch, not a complete retained-login schema or an implemented `SessionStore`. Current `SessionClaims` has no `sid`; `core/store.ts` has no session registry, and D1's current redemption CAS updates only a grant. The standalone selection-context codec and mutation guard are built in `src/core/selection-context.ts`; registry, retention, integration and UI remain unbuilt. [Multiple logins and account switching] owns the browser protocol, selection/version errors, pending-link atomic completion and concrete capacity/cleanup defaults. Both proposals use one session substrate, not competing registries. The user authorized starting implementation; this documentation subtask makes no code changes or commits. Deployments and live migrations require separate authorization.

**Three explicit modes.** With neither `sessions` nor retention configured, keep today's signed single-session cookie and zero-config behavior, including stateless email evidence plus live policy checks and grant re-joins. Registry-only mode opts into `sessions?: SessionStore`, a `sid`-bearing cookie and registry checks, without forcing a browser roster or picker. Retained mode separately opts into `retainedLogins` and requires an adapter with atomic browser-set operations. It uses a stable opaque HttpOnly browser handle and server-retained session rows instead of sending all accounts in cookies; inactive login evidence never enters JavaScript/localStorage. Do not interpret a registry-only adapter as sufficient support for retention.

**Rows and authority.** Extend the sketch with original `issued_at` for rotation checks and gate isolation. Retained mode additionally requires browser-set membership, browser-set absolute expiry, nullable active session and monotonic `selectionVersion`, plus distinct browser-bound pending-link and operation-result records. Store only the keyed hash of the random browser handle. Session selectors and `sid`s are identifiers, not bearer credentials: every operation must establish ownership through the cookie and gate. Missing, expired or revoked rows deny even if a signature verifies. No automatic fallback to another retained account or the legacy cookie is permitted. Importing a valid legacy session, if supported, must preserve issued-at and absolute expiry, revalidate live authority and not spend another redemption; legacy claims never receive a synthetic fresh lifetime.

**Selection and stale requests.** Planned list/whoami snapshots return safe candidate metadata and selection context `{ browserSetId, sessionId, version }`, all `no-store`. `sessionId` is nullable; `version` is a nonnegative safe-integer number excluding negative zero, never reset/reused within a browser set. The implemented `nextSelectionVersion()` increments it and fails at `Number.MAX_SAFE_INTEGER`; exhaustion requires failing closed or establishing a new unique browser-set ID, never wrapping. Browser-set IDs must not be reused across gates. Add/select/remove/resolve/sign-out require store compare-and-swap on the expected context and atomic membership/capacity checks; that storage integration is unbuilt. Changes to roster, selection or pending candidates increment the version; last-seen does not. Cookie-authenticated mutations in retained mode supply `X-OA-Selection-Context`: canonical unpadded base64url JSON in exactly the key order `{ browserSetId, sessionId, version }`, produced by `serializeSelectionContext()`. IDs are nonempty strings of at most 256 characters; the encoded header is at most 2048 characters. The implemented parser rejects malformed/noncanonical input and extra fields. After authentication/authorization, before side effects, `checkSelectionContext()` compares against the caller's validated current selection. Missing, malformed or stale context returns `409` with `{ error: 'selection_context_conflict', recoverable: true, action: 'refresh_selection' }`, JSON content type and `Cache-Control: no-store`, with no mutation side effects. The planned client integration refreshes identity but never automatically replays under a different account. The context is not signed/encrypted, authentication or CSRF protection; a matching signed-out context confers no authority. Explicit Bearer API credentials retain request-scoped precedence and need no browser-selection header. The standalone guard is an admission-time comparison with a pinned actor, not a store/CAS lock, a transaction with downstream business storage or a promise to cancel in-flight work. Use authoritative selection/revocation reads in phase 1; optional caching with delayed revocation is a future explicitly weakened consistency mode, not the default.

**Atomic operations, not composable row I/O.** A retained-capable adapter must supply atomic CAS add/select/remove/sign-out-all and `commitIncoming` (names provisional). Incoming completion must consume valid browser-bound pending proof, recheck the captured token hash and live grant guards, debit at most one redemption, create session/membership, record the operation result and update selection/version together, or change none of them. Exact browser-bound retries return the same session without replaying selection after a subsequent switch. Existing valid grant-session selection spends no redemption. Capacity failure must not consume proof, debit a grant or discard another account. Email-code completion also needs an atomic proof-consumption/session-insert capability for registry mode; today's separate `PendingAuthStore.consume()` then `gate.signIn()` is not such a capability. Unsupported adapters fail configuration rather than silently providing weaker guarantees.

**D1 boundary.** Co-locate grant, pending-link, registry, browser-set and operation-result rows in one D1 database for atomic incoming completion. [D1's batch API] accepts a prepared statement list and rolls the sequence back on SQL errors; it is not an interactive transaction surrounding core callbacks, and `withSession()` provides sequential consistency rather than a transaction. A conditional write returning zero rows does not itself abort the batch. Require a demonstrated SQL dependency/constraint design and adapter tests proving all-or-nothing behavior under zero-row guards, injection failures, duplicate requests, concurrent cap/selection changes and lost responses. Reading batch results and compensating afterward does not meet the contract. No cross-database or IdP/network atomicity is promised; proof validation outside SQL must be bound to the committed operation. D1 support remains a feasibility checkpoint until this is proven, not something the existing redemption method already provides.

**Preserved lifecycle.** Disable, exhausted redemption caps and link expiry block new sessions, not necessarily existing ones. Disabled/exhausted links leave valid retained sessions selectable. Link expiry ends existing sessions only when the live `expiryEndsSessions` flag is true; otherwise their own absolute session/browser expiry still applies. Revocation always ends grant sessions; rotation with `endSessions` keeps the existing issued-at cutoff semantics. Plain rotation invalidates old-token pending proof without invalidating existing sessions. Switching never extends expiry; live policy and grant checks continue on every authenticated request. Sign-out removes/revokes this browser's selected session or set, never globally revokes the shared grant or all devices implicitly.

**Bounds and operations.** Adopt the companion proposal's defaults: 8 retained sessions and 4 live pending contexts per browser/gate, 10-minute pending proof, 24-hour operation-result retry window and 30-day absolute browser-handle lifetime. Expiry is enforced on access independently of deletion. Capacity returns explicit `409` conflicts with no silent eviction; finite gate-wide issuance/rate/storage quotas prevent bypass through new browser handles. Expose idempotent indexed cleanup in batches of at most 200 rows by default, with a continuation cursor; consumers arrange hourly scheduling or equivalent maintenance. Cleanup preserves retry results until their deadline and never extends credentials. Rate/storage rejection occurs before any proof consumption or redemption. Throttle last-seen writes separately and apply existing audit/privacy retention to metadata, not credentials. Registry-only consumers must also configure bounded issuance/storage and cleanup; they do not inherit a retained-roster UI.

**Release gates.** Exact structured tests must cover absent-store compatibility, live lifecycle boundaries, registry/cookie disagreement, CAS conflicts, A → B → A stale forms, cross-browser/gate selectors, capacity without redemption loss, duplicate completion, SQL rollback after each write stage, old-token pending proof after rotation and cleanup independent of logical expiry. Browser tests belong to the later implementation phase; resource support below remains separate and is not a prerequisite for registry or account switching.

## 2. `resource` on a grant

mortgage-viz has the most developed version of this: `functions/api/docs/[id]/grants.ts`, `grants/[gid].ts`, `doc-auth.ts` — per-document share links. This repo can't express that, because a grant carries a scope *list* and no notion of what it's a grant *to*.

Add an optional `resource: string | null`. `hasScope(auth, scope)` gains a resource-aware sibling; a grant with `resource` set is refused for any other resource. Nullable keeps every existing consumer unchanged.

This is the whole tie-in to the state-sharing work, and deliberately the only one — see §4.

## 3. Stop needing Cloudflare Access — **built** (2026-09)

*Both paths shipped: `adapters/oidc.ts` (`oidcStart`/`oidcCallback`, One Tap; `specs/done/google-oidc-idp.md`) and `core/email-codes.ts` (magic link + 6-digit code over `adapters/resend.ts`, with `scripts/provision-resend.mjs` for the domain). gcs is cutting over from Access on this basis. Kept below as written.*

Two paths, neither of which makes this an IdP (no password store, no OAuth server — that stays out of scope):

- **Magic-link email sign-in as a first-class flow.** `anyEmailPolicy` + an emailed token already *is* passwordless sign-in: no CF Access, no Google, and a sign-in page the app styles completely. It's filed as a policy helper rather than as the feature it is. Needs the ESP from `auth-upstream-followups.md` §4 to be real.
- **A generic OIDC adapter** (`adapters/oidc.ts`): code → token → email → `signIn(email)`. ~100 lines, covers Google/GitHub/anything, and removes CF Access from the path — which also removes its unstylable "choose auth method" chooser. `cf-access` stays as one adapter among several rather than the assumed one.

## 4. State-sharing stays out

`use-remote-state` (`~/c/js/use-remote-state`) is real: content-addressed slugs over a `StorageBackend`, `putNamed` for vanity names, no auth. mortgage-viz doesn't depend on it yet.

The factoring:

- **this repo** — who you are, what you may see. Gains `resource` so "anyone with this link can view *this doc*" is expressible.
- **use-remote-state** — state blob ↔ slug. No auth.
- **use-prms** — URL params, used by both, owned by neither.

Composed as separate params: `?doc=<slug>&key=<token>` — the slug says *what*, the token says *may*. Keeping them separate matters, because a public view should be shareable with the auth system entirely out of the path, and the token is a secret that must never reach a log or a slug store. Folding state in here would couple them permanently and buy nothing.

## 5. Demo rebuild — **built** (2026-09; see [`done/demo-rebuild.md`](done/demo-rebuild.md))

The current demo funnels into a sandbox, which buries the thing worth showing.

- **Home** — brief intro to the library, then the simplest possible gated flow. "Sign in with email" (qualified: this demo accepts anyone; a real deployment restricts by domain, allowlist, or approval), and below it, more prominently, the magic-link pitch with a real clickable `?key=` link that bypasses the flow above.
- **Two demo links, side by side** — one carrying a name and avatar, one bare. The chip/watermark/notice difference *is* the anti-forwarding argument, made visually: one of those is uncomfortable to pass along and the other costs nothing.
- **Dashboard** — one big placeholder instead of fake tables. The subject is the visitor's own identity: which subject they are, how they got in, when it expires, and a nudge to sign out and come back a different way.
- **Admin** — a de-emphasised power-user tease, not the front door. Sandbox identities get Docker-style two-word names so "you're in a sandbox" is implicit rather than explained in a paragraph. Links minted there are full-fidelity for anyone in the world.
- Throughout: "memo" rather than name/note, pre-filled so minting needs no typing; GitHub link in the header on every page; `/admin` labelled **Admin**, not "Console".
- Drop "I just opened a link — retry". It's a workaround wearing a feature's clothes: the real fix is `refetchOnWindowFocus` with `staleTime: 0` while signed out, so a tab notices when another tab redeemed a link.

[Multiple logins and account switching]: multiple-logins-and-account-switching.md
[D1's batch API]: https://developers.cloudflare.com/d1/worker-api/d1-database/#batch
