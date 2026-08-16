# Share links, request-access, and the access log

*(RW + session, 2026-08-15. Extends [`overview.md`](./overview.md), which specced the session/grant substrate but left the share-link **configuration surface**, the **request-access** flow, and the **audit/analytics** story unwritten.)*

**Implementation status (2026-08-16):** §0 (core/adapters split), §1 (share-link config surface + redemption semantics), and §3 (access log) are **built** — see `src/`, `migrations/`, and the deltas noted inline below. §2 (request-access), §4's beacon/rollup work, §5's watermark/disclosure UI, and §6's vendored FE are **not**.

Framing: the product is *"share a sensitive dashboard view with a named person via a link, and know what happened."* That's the differentiated thing — sessions/SSO are table stakes.

## 0. Scope & naming (revisit)

The kernel here — HMAC sessions, hashed grant tokens, scopes, redemption accounting, audit log, request-access — is **runtime-agnostic already**, because it's constrained to Web Crypto + a SQL store. CF-specific surface is exactly two adapters:

- **IdP**: `verifyAccessJwt` (CF Access RS256 vs team certs). Peers: Google/GitHub OIDC, WorkOS, plain magic-link-only (no IdP).
- **Store**: D1. Peers: any SQLite (Turso/better-sqlite3), Postgres.

So the honest structure is `core/` + `adapters/{cf-access,d1}` — and the original name (`cf-gate`) undersold it. Settled 2026-08-16 on **`@open-athena/auth`** (repo `Open-Athena/auth`), after a detour through product-y names: the scope already namespaces it, so the bare word is unambiguous and needs no explaining. The scope mismatch to watch is the opposite one — "auth" reads broader than this is — so the README leads with what it actually does (share links + SSO + audit) and disclaims the rest (no password store, no OAuth server, no RBAC engine).

The CF coupling is real but small; build the adapters as a *file boundary*, not an abstraction layer — no plugin registry, no DI container, just `core` importing an interface that `adapters/d1` satisfies in ~40 lines. Every current consumer (watchy, marin-gcs-usage, mortgage-viz, applitrack) is on CF, so CF adapters stay the only ones that exist until a non-CF consumer appears.

## 1. Share links (grants) — configuration surface

Every knob optional, defaults sane, zero-config = "unlimited-use, never-expires, unnamed link" (today's behavior).

```sql
-- extends 0007_grants.sql
grants (
  id            TEXT PRIMARY KEY,
  token_hash    TEXT NOT NULL,      -- SHA-256; raw token shown once at creation
  name          TEXT,               -- admin-side label: "Bob Smith (donor)"
  note          TEXT,               -- freeform: why this exists
  subject_json  TEXT,               -- optional pre-loaded identity: {first,last,email,avatar}
  email         TEXT,               -- if set: magic-link semantics (bind on redeem)
  scopes        TEXT NOT NULL,      -- space-separated
  max_redeems   INTEGER,            -- NULL = unlimited
  redeems       INTEGER NOT NULL DEFAULT 0,
  expires_at    INTEGER,            -- NULL = never
  session_ttl   INTEGER,            -- seconds; NULL = inherit app default
  created_at    INTEGER NOT NULL,
  created_by    TEXT NOT NULL,
  revoked_at    INTEGER,
  first_used_at INTEGER,
  last_used_at  INTEGER
)
```

*Built as `migrations/0001_grants.sql`, with two deltas: `id` is a random 9-byte base64url string rather than an opaque TEXT of unspecified provenance (autoincrement or sequential ids in URLs leak grant counts), and `token_hash` carries a `UNIQUE` constraint. Timestamps are epoch seconds as written here — a deliberate break from watchy's ISO-text columns, which is why re-pointing watchy needs a migration (see `overview.md` §"Schema changes").*

**Redemptions ≠ requests.** `max_redeems` counts *sessions minted* (≈ distinct browsers), not HTTP requests. *Built: the cap is enforced only in `redeem()`, and as a single-statement compare-and-swap (`UPDATE … WHERE … AND (max_redeems IS NULL OR redeems < max_redeems) RETURNING …`) — a read-then-write would let two simultaneous opens both pass a `max_redeems: 1` check. `authenticate()` never spends a redemption, so `Bearer`/`?key=` script use and ordinary page loads don't burn the cap; the trade is that a capped link used purely as a script credential bypasses the cap, which is the right reading of "sessions minted".* This is what makes "one-use link" mean something a human would predict. Note in the admin UI that `max_redeems: 1` is **hostile UX in practice** — the recipient opens it on their phone, then their laptop, and is locked out; prefer unlimited-redeem + named + logged + revocable, and reach for 1 only for genuinely single-shot flows (password-reset-shaped).

**Redemption flow** (already sketched in `overview.md`): `?key=<token>` → `POST /auth/exchange` → validate (not revoked, not expired, redeems < max) → mint session cookie → `history.replaceState` strips the param. Additions:

- **Session ≠ grant lifetime**, but sessions re-join their grant on *every* request (mortgage-viz's design, already adopted) — so revoking the grant kills every session it minted, instantly. Keep this; it's what makes the whole social story workable.
- **Cookie, not localStorage.** The parent spec's session is an HttpOnly/SameSite=Lax/Secure cookie, and that should stay: an LS-held token is readable by any XSS on the page, can't be HttpOnly, and doesn't auto-attach to `fetch` of gated APIs. "Indefinitely" is a *TTL* choice (`session_ttl` → cookie `Max-Age` of months) not a *storage* choice. Only use LS if a non-cookie consumer genuinely needs the token in JS (cross-origin script, native app), and then treat it as a `Bearer` credential.

## 2. Request access ("enter your email")

Wall gets a second affordance next to SSO: **Request access**.

```sql
access_requests (
  id, email, name, note, created_at,
  status,        -- pending | approved | denied | auto
  decided_at, decided_by, grant_id   -- grant minted on approval
)
```

Flow: visitor submits email (+ optional note) → row inserted `pending` → admin notified (Slack webhook / email — app-configurable) → admin approves in `/access` → **a grant with `email` set is minted and delivered to that address**.

- **No pre-verification round-trip needed**: approval delivers via email, so someone who types a stranger's address merely causes mail to the real owner. Cheaper than a confirm-then-request dance, equally safe.
- **Auto-approve rules** (optional): domain match (`@openathena.ai` → `auto`, grant minted immediately) — this is where the parent spec's *allowlist open question* resolves: a small `policy` fn `(email) => scopes | null`, DB-backed allowlist optional on top.
- **Abuse control**: rate-limit per IP + per email, honeypot field, cap pending rows. CF Turnstile is the natural escalation (free, same platform) but shouldn't be required by default.
- **Requester UX**: after submit, show "pending" state (a signed cookie holding the request id) so a re-visit doesn't re-submit; approval mail is the completion signal.

## 3. Access log (audit)

```sql
access_log (
  id, ts,
  event,          -- redeem | request | deny | revoke | view | signin
  grant_id, session_sub,
  path, status,
  ip_hash,        -- HMAC(ip, secret): correlate without storing raw IPs
  ua, country, referer
)
```

`authenticate()` already runs on every gated request, so it's the natural emit point. Two-tier volume control: always log auth-lifecycle events (`redeem`/`deny`/`revoke`/`request`); log `view` events **deduped per (session, path, hour)** so a chatty SPA doesn't write thousands of rows.

*Built as `migrations/0002_access_log.sql`, plus two columns this sketch didn't have: `reason` (why a `deny` happened — `bad-token` | `revoked` | `expired` | `exhausted` | `not-allowed`, which is most of what makes the log worth reading during an incident) and `bucket` (`floor(ts/3600)` on `view` rows, NULL otherwise). The dedupe is a **partial unique index** on `(session_sub, path, bucket) WHERE bucket IS NOT NULL` with `ON CONFLICT DO NOTHING` — enforced by the DB rather than by a read-then-write race in the worker, and structurally unable to swallow a lifecycle event. `signout` joined the event vocabulary.*

*Not logged: an absent credential. An anonymous request is not a denial, and logging one per public page load would drown the signal — so `deny` rows mean "someone presented something that didn't work", which is the question the log is actually asked.*

What the admin view then answers, which is exactly the user-facing ask:

- "Bob's link: created 3 weeks ago, redeemed **4 times** from **2 countries**, last seen 2h ago, 37 views, mostly `/finances/2025`."
- Distinct-session-count per grant is the **forwarding signal**: one person ≈ 1–3 redemptions (phone/laptop/work); 9 redemptions across 5 ASNs means the link left the intended hands. Surface it as a soft badge, not an alarm.

## 4. Analytics: one store, not two

**Default: the gate's own D1 log is the analytics store — for authed *and* anonymous traffic.** The gate middleware already runs on every request (that's how `authenticate()` works), so it is the natural single emit point, and "who viewed what" joins to `grants` natively rather than across systems.

Rejected alternative (an earlier draft of this spec): first-party log for identified traffic + Umami/Plausible for anonymous. That splits one question across two query surfaces — answering "how much of last week's traffic was Bob vs. strangers" would mean querying both and reconciling. Not worth it.

Note also what the sensitivity argument does and doesn't say. The *data* being viewed never leaves D1 either way; only event metadata is at issue, and a **self-hosted** Umami is the user's own box, so "third party" doesn't even apply. The residual concerns are narrower:

- *Hosted* Plausible would put named-viewer behavior (a donor reading finances) on a vendor's servers — modest, but a real reason to prefer self-hosting if an external tool is used at all.
- **Design fit** is the stronger argument: Umami/Plausible are anonymous-first by construction (hashed visitor ids, no stable person key); grafting grant identity on fights their grain, while `access_log ⋈ grants` is native here.

What that implies to build (all small, and watchy is already a D1-events-with-charts dashboard — the marginal cost is a query + a page):

- Middleware logs every request, not just gated ones: `ts, path, status, grant_id?, session_sub?, ip_hash, ua, country, referer`. CF supplies `country`/ASN on `request.cf` for free.
- A ~20-line first-party beacon for client-only signals (SPA route changes, viewport, time-on-page), posting to `/api/track` — same store, no third-party script, no cookie banner.
- Bot filtering (UA regex + CF signals) and a retention/rollup job (raw rows → daily aggregates) — the two things the hosted tools would otherwise do for you.

**Complement, don't join: Cloudflare Web Analytics** (free, zero code, beacon injected at the proxy) for RUM — Real User Monitoring, i.e. Core Web Vitals (LCP/INP/CLS) sampled from actual visitors' browsers, as opposed to synthetic lab runs like Lighthouse. It answers a question ("what fraction of real users saw a slow load?") that never needs joining against the access log, so it costs nothing architecturally. Recommended in the hccs/ctbk session (2026-06-13); Sentry Performance is the escalation if per-route traces are ever wanted.

**Reach for Umami only** if the polished dashboard is wanted sooner than it can be built here — it's a real tradeoff (free UI now vs. one store later), not a wrong answer. Prior recommendation from hccs/crashes (2026-05) was Plausible (cloud, ~$9/mo) or self-hosted Umami (MIT); self-hosted Umami matches the stated free/self-hosted preference.

## 5. Social/normative design (the part that isn't code)

Sharing "here's a link that logs you right in" to actually-sensitive material has social failure modes that no ACL fixes. Positions worth baking into defaults:

- **Assume forwarding.** Links get pasted into email threads and Slack. Design so forwarding is *visible and revocable* rather than *prevented* — prevention (1-use, IP-pinning, device-binding) reliably breaks legitimate users first.
- **Disclose the logging.** A footer on gated views — *"Private link for Bob Smith · access is logged"* — is the single highest-leverage feature here. It (a) sets accurate expectations, so nobody is betrayed by discovery later, and (b) empirically dampens casual forwarding harder than technical controls, because the recipient now knows the link is attributable to *them*.
- **Watermark for the sensitive tier.** Rendering the grant's name in-page (the data-room convention) makes screenshots attributable. Cheap: the gate already knows `name`/`subject_json`.
- **Expiry as a social tool.** "This link works for 30 days" bounds propagation without accusing anyone; renewal is one click.
- **Revoke should land softly.** A revoked/expired link shows the *request-access* wall, not a bare 403 — the person who legitimately lost access self-serves, and the person who shouldn't have it hits a door that names itself.
- **Asymmetry is a choice.** Optionally show the viewer their own trail ("you've viewed this 4 times"), which is the honest version of the relationship and costs nothing.

Per-app tuning is expected: a donor dashboard wants named + watermarked + disclosed; a link to a public-ish chart wants none of it. Ship these as flags, defaulted per tier.

## 6. Packaging: package the kernel, copy-in the UI

Connects to the fork-vs-package thread (see the awair session's `git subtree` discussion — `subtree split` rewrites paths mechanically for upstreaming; `git-subrepo`/`josh` as heavier alternatives).

- **Backend kernel = a real package, not a fork-and-tweak.** Auth code is precisely where *silent divergence is dangerous*: a cookie-flag fix, a timing-safe comparison, a token-entropy bump must reach every consumer, and a fleet of quietly-forked copies guarantees it won't. The pltly fork fragmentation (three live pins of the same fork across seven consumers) is the cautionary data point.
- **FE wall/admin UI = copy-in (shadcn-style), vendored via `git subtree`.** Branding, copy, and layout of the sign-in wall are inherently per-app; a styled component library would be fought by every consumer. Vendoring under `vendor/` with subtree keeps a real merge path in both directions.

That split — *security-critical logic packaged, presentation vendored* — is the general rule, not just this project's.

## Open questions

- **Publish identity** (settled): GH `Open-Athena/auth`, npm `@open-athena/auth`. The npm org **already exists** — RW (`rdub`) is its sole owner, having registered it earlier and forgotten; `openathena` is also held, as a defensive squat on the hyphenless variant. Pending: create the GH repo, and invite other OA members to the npm org so the namespace isn't bus-factor-1. Personal consumers (mortgage-viz, watchy's `rw` instance) consume the OA-scoped package; that's fine and needs no second package. If ownership ever has to move, GH transfers preserve redirects while a published npm name can only be deprecated-and-republished — so the scope is the decision to be sure about, and it's now made.
- Notification transport for request-access (Slack webhook vs email) — package concern or app concern? (Same shape as the parent spec's magic-link-delivery question; probably one pluggable `notify(event)` hook answers both.)
- ~~Does `view`-event logging default **on** or **off**?~~ (Settled: **off**, via `logViews` on `createGate`. Privacy-forward, and turning it on is the same edit as shipping the disclosure copy.)
- Admin UI: extend watchy's `/access` page, or ship the vendored-in admin as part of Layer B?
- Should `session_ttl` cap at the grant's `expires_at`? Today they're independent — a 30-day cookie on a 1-hour link is minted, and the per-request grant re-join is what actually stops it at the hour mark. Correct, but it leaves a dead cookie in the browser; clearing it on the deny path may be the friendlier behavior (and is what makes "revoke lands softly" in §5 work without a stale-session flicker).
