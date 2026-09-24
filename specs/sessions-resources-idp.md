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

**What it buys, beyond listing.** `sessionTtlS` is baked into the cookie at redeem, so `update()` changing it today only affects *future* redemptions. With a registry, expiry is enforced server-side, so after-the-fact policy changes actually bite. Same for `expiryEndsSessions` flipped after minting.

**Costs to be honest about.** SSO sessions become stateful (one read per request, cacheable with a short TTL at the cost of a bounded delay on revocation). Rows need expiring. And the registry can disagree with a validly-signed cookie — the rule should be that the registry wins, since that's the entire reason it exists.

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

## 5. Demo rebuild

The current demo funnels into a sandbox, which buries the thing worth showing.

- **Home** — brief intro to the library, then the simplest possible gated flow. "Sign in with email" (qualified: this demo accepts anyone; a real deployment restricts by domain, allowlist, or approval), and below it, more prominently, the magic-link pitch with a real clickable `?key=` link that bypasses the flow above.
- **Two demo links, side by side** — one carrying first/last/avatar, one bare. The chip/watermark/notice difference *is* the anti-forwarding argument, made visually: one of those is uncomfortable to pass along and the other costs nothing.
- **Dashboard** — one big placeholder instead of fake tables. The subject is the visitor's own identity: which subject they are, how they got in, when it expires, and a nudge to sign out and come back a different way.
- **Admin** — a de-emphasised power-user tease, not the front door. Sandbox identities get Docker-style two-word names so "you're in a sandbox" is implicit rather than explained in a paragraph. Links minted there are full-fidelity for anyone in the world.
- Throughout: "memo" rather than name/note, pre-filled so minting needs no typing; GitHub link in the header on every page; `/admin` labelled **Admin**, not "Console".
- Drop "I just opened a link — retry". It's a workaround wearing a feature's clothes: the real fix is `refetchOnWindowFocus` with `staleTime: 0` while signed out, so a tab notices when another tab redeemed a link.
