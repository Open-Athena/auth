# Seed a self-serve profile from the OIDC id_token (name + Google avatar)

*(Requested by hccs-funds, 2026-09-20. Extends [`self-serve-profiles.md`](./done/self-serve-profiles.md) (the `profiles` table + `subjectFor` that already render a self-set name/face) and [`google-oidc-idp.md`](./done/google-oidc-idp.md) (the `oidcCallback` / `googleOneTapVerify` flows that currently discard everything but `email`). This is the "auto-populate" counterpart to the self-serve panel: the profile a user would otherwise have to fill in by hand is pre-filled, once, from what Google already verified about them.)*

## Why

`oidcCallback` and `googleOneTapVerify` request `scope: 'openid email profile'`, so the verified id_token carries `name` / `given_name` / `family_name` / `picture` — and both handlers throw all of it away, calling `gate.signIn(claims.email, request)` with the email alone. The `profiles` table (from `self-serve-profiles.md`) is therefore empty for every SSO principal until they open `ProfilePanel` and type their own name / upload a face. In practice nobody does, so `<WhoamiChip>` shows initials-of-email for the whole board, forever, even though Google handed us a real name and photo at sign-in.

hccs-funds hit this directly: "use the user AVI from Google — do we get that during auth? can we?" We *do* get it; we just drop it. This spec captures it.

**The privacy constraint is non-negotiable and already solved.** A Google `picture` is a live `lh3.googleusercontent.com` URL. Persisting or rendering it as a URL would leak "this person opened this private page" to Google on every render — exactly the leak `self-serve-profiles.md` §"What already exists" calls out. So seeding must **fetch the picture server-side and inline it as a `data:` URI**, via the same `resolveAvatar({ url }, { inline: true })` path the self-serve `{ url }` source already uses. No new inlining code — this is a new *caller* of an existing primitive.

This stays *gating*: a name and a face, captured from the IdP that already verified them. No new identity surface.

## What already exists (reuse, don't rebuild)

- **`resolveAvatar({ url }, { inline: true, maxBytes })`** (`core/avatar.ts`) — fetches an https image server-side, validates it's `image/*` (never `image/svg+xml`), caps at `MAX_INLINE_AVATAR_BYTES` (64 KB), returns a `data:` URI or `null`. Injectable `fetch` for tests. This is precisely what a Google `picture` URL needs; it is already what `resolveAvatarInput`'s `{ url }` branch calls.
- **`resolveAvatarInput` / `putProfile`** (`core/gate.ts`) — the write path that turns an `AvatarInput` into a stored `Profile`, cleans the name (`cleanName`, `MAX_PROFILE_NAME`), and records `avatarSrc` provenance.
- **`subjectFor(email)`** (`core/gate.ts`) — re-derives `Subject {first,last,avatar}` from the profile row on **every** `authenticate`/`signIn`, so a freshly-seeded row is live on the next request with no session reissue needed.
- **`cleanName(value)`** (`core/profile.ts`) — control-char flatten + cap + trim, already applied to self-asserted names; reuse verbatim for the id_token `name`.

The new work is: extract the claims, decide whether to seed (provenance), inline the picture best-effort, and write the row — behind an opt-in flag, without ever letting a seed failure break sign-in.

## 1. When to seed (provenance — the one real design decision)

Seeding must **never clobber a self-set profile.** A user who opened `ProfilePanel` and chose their own name/face has expressed intent that outranks the IdP.

**Baseline (recommended, migration-free): seed only when no row exists.**
`if (await profiles.get(email)) return` — skip. The first-ever SSO sign-in for an email with no `profiles` row seeds it; every subsequent sign-in is a no-op. Any `ProfilePanel` edit (including *clearing* the avatar, which still writes a row with `avatar=null`) creates a row and thereby permanently opts that principal out of re-seeding. This needs **no schema change** and has the right semantics for the 99% case. Cost: if Google's photo later changes, the stored copy doesn't refresh, and a user who has never edited but wants the new photo has no in-band way to force it (they'd use `ProfilePanel`'s `{ gravatar }`/upload, or an admin clears the row). Acceptable — stability over freshness for a gating avatar.

**Optional extension (only if an adopter asks for refresh-on-login): provenance column.**
Add `avatar_src`/row-level provenance value `'oidc'` (extend `AvatarSourceKind` to `'upload' | 'url' | 'github' | 'gravatar' | 'oidc'`), plus a way to know the *name* was auto-seeded vs. self-typed. Cleanest is a single row-level marker — a new `managed TEXT` column on `profiles` (`'oidc'` when seeded, set to `'self'` by any `putProfile` from the self-serve route). Then seed when `row is null || row.managed === 'oidc'`, and refresh the inlined photo each login; `managed === 'self'` is untouchable. This is a new package migration (`0009_profile_managed.sql`) and a `putProfile` tweak to stamp `'self'`. **Do not build this unless someone needs refresh** — the baseline is enough for hccs-funds.

Spec the baseline; note the extension as a labeled follow-on.

## 2. The seam — a gate method the handlers call

The OIDC adapter has the claims; the gate owns the profile store, `resolveAvatar`, and `subjectFor`. So put the logic on the gate and have the adapter call it.

Add to `Gate` (in `core/gate.ts`):

```ts
/**
 * Best-effort: seed the profile for a just-signed-in SSO principal from IdP
 * claims, when there is no self-set profile to override (see spec §1). Inlines
 * the picture server-side as a data: URI; a fetch failure or oversize image
 * degrades to name-only, never throws. No-op without a profile store. Returns
 * the resulting Subject (or null) so a caller can reissue the session subject.
 */
seedProfileFromClaims(
  email: string,
  claims: { name?: string; given_name?: string; family_name?: string; picture?: string },
): Promise<Subject | null>
```

Behavior:
- No `profiles` store bound → return `null` (matches `subjectFor`).
- Apply the §1 provenance check; if skipping, return the *existing* `subjectFor(email)` unchanged.
- Names: prefer `given_name`/`family_name` → `Profile.first`/`last`; else split `cleanName(name)` on the last space (best-effort, same lossy split the panel tolerates). Empty → `null`.
- Avatar: if `picture` is a safe https URL, `resolveAvatar({ url: picture }, { inline: true, fetch })`; on `null`/throw, leave avatar `null`. **Wrap the whole avatar step in try/catch** — the picture host is third-party and attacker-adjacent to sign-in latency; a slow/failing fetch must not fail or noticeably delay login. (Consider a short timeout on the injected `fetch`, or document that the caller may pass one.)
- Write via the **internal** profile-put path, bypassing `mayEditProfile` and `profileMinEditIntervalS` (this is system-sourced, not a user edit — the rate-limit that protects the self-serve route is irrelevant and would wrongly block a legitimate first login). Stamp `avatarSrc` (`'url'` in the baseline, or `'oidc'` if the extension lands).
- Return the fresh `subjectFor(email)`.

## 3. Adapter wiring — opt-in flag

Add `seedProfile?: boolean` (default **false**) to `OidcOptions` and `OneTapVerifyOptions`. Off by default because it only does anything when a profile store is bound and an adopter has decided auto-capture is what they want (some may prefer initials-only, or self-serve-only).

In `oidcCallback`, after the successful `gate.signIn(claims.email, request)`:

```ts
if (seedProfile) {
  const subject = await gate.seedProfileFromClaims(claims.email, claims).catch(() => null)
  // signIn already computed the cookie's subject from the pre-seed row; the
  // seeded subject is live on the next authenticate() regardless (subjectFor
  // re-derives per request). Reissuing here only avoids one initials-first
  // render — do it if cheap, but a plain no-op is also correct.
}
```

Extend `IdTokenClaims` to type the optional `name`/`given_name`/`family_name`/`picture`. Same addition in `googleOneTapVerify` after its `signIn` (the 200-with-`set-cookie` branch).

**Decide and document**: does the *first* response already carry the seeded subject, or does it appear on the next `whoami` poll? Since `signIn` computes `subject` before seeding, the zero-extra-work answer is "next poll" (a brief initials flash for one first-ever login). If that flash is unwanted, reissue the session cookie in the handler from the returned subject. Recommend: reissue in `oidcCallback` (it's already minting a redirect with a `set-cookie`), accept next-poll for One Tap (the FE re-fetches `whoami` immediately anyway). Pick one, don't leave it ambiguous.

## 4. Testing — `src/testing/` + `test/oidc.test.ts`

Reuse the injectable `fetch` already threaded through `oidcCallback`/`resolveAvatar`:
- **Seeds name + inlined avatar on first sign-in.** Stub the token endpoint + JWKS to yield an id_token with `name`/`picture`; stub the picture fetch to return a small PNG. Assert the stored `Profile` equals `{ email, first, last, avatar: <data: URI>, avatarSrc: 'url', updatedAt }` (exact-equality per repo testing rules — normalize `updatedAt`), and that the next `authenticate` returns a `subject` with that avatar.
- **Never clobbers a self-set profile.** Pre-put a profile, sign in with different claims, assert the row is byte-identical afterward.
- **Avatar fetch failure degrades to name-only, sign-in still succeeds.** Picture fetch → 500 (or oversize > 64 KB); assert `avatar === null`, name still set, sign-in response is the normal 302/200.
- **`seedProfile` off → no row written** (default behavior unchanged; guards the opt-in).
- **No profile store bound → no-op, sign-in unaffected.**
- **One Tap parity**: the same seed on `googleOneTapVerify`'s success path.

## 5. Adopter integration (hccs-funds first)

hccs-funds does **not** currently bind a profile store — `createGate({...})` omits `profiles`, so `subjectFor` already returns `null` for everyone. To benefit, hccs-funds will (app-side, separate from this package change):
1. Bind `profiles: d1ProfileStore(env.DB)` in its `gate()` (`functions/_lib/gate.ts`); the `profiles` table already exists (migration `0010_auth_profiles.sql` vendored locally).
2. Pass `seedProfile: true` in its `oidcConfig` (`OidcOptions`).
Then the existing upper-right `<WhoamiChip avatar>` renders each board member's Google name + face with no further app change. (It does *not* need to mount `ProfilePanel` — auto-seed alone satisfies the ask; the panel remains the escape hatch if someone wants to override.)

Note this dependency direction in the as-built: shipping the package change unblocks a two-line app change downstream.

## Open questions

- **First-response subject vs. next-poll** (§3) — pick reissue-in-callback for the redirect flow unless there's a reason not to.
- **Picture-fetch timeout** — is a default timeout worth adding to `resolveAvatar`'s inline path, or left to the injected `fetch`? Sign-in latency is the only thing at stake; a 2–3 s cap seems prudent and reusable.
- **Refresh-on-login** (§1 extension) — leave unbuilt until an adopter asks; if built, it's the `managed` column + `putProfile` stamp, not a rework of this flow.

## As built (2026-09-22)

Baseline shipped; no migration (the `profiles` table already exists). Both open design questions resolved:

- **`gate.seedProfileFromClaims(email, claims, nowMs?)`** (`core/gate.ts`) — exactly the spec's §2 method. Provenance is the §1 baseline: `if (await profiles.get(email)) return subjectFor(email)` — first-ever sign-in seeds, every later one is a no-op, any `ProfilePanel` edit permanently opts out. Names prefer `given_name`/`family_name`, else split `cleanName(name)` on the last space. The picture inlines via the existing `resolveAvatar({ url }, { inline: true })` (never the live `lh3` URL); a failure or timeout degrades to name-only. Writes straight through `profiles.put` — no `mayEditProfile`, no `profileMinEditIntervalS` (system-sourced, not a user edit).

- **Reissue vs. next-poll (§3) — resolved to *neither needed*.** The session subject isn't cookie-borne; `subjectFor` re-derives it on every `authenticate`. So both handlers simply **`await gate.seedProfileFromClaims(...).catch(() => null)` before responding**, and the seeded name/face is already present on the browser's *first* `/whoami` — no cookie reissue, no initials flash, for both the redirect and One Tap flows. Best-effort: a seed failure never turns a successful sign-in into an error.

- **Picture-fetch timeout (§3) — added, on the gate.** `GateOptions.seedAvatarTimeoutMs` (default **3000**, 0 disables) bounds only the seed's avatar fetch via `AbortSignal.timeout`; a user-initiated `putProfile` copy is left unbounded (it's not on anyone's login path). A timeout surfaces as name-only, same as any other fetch failure.

- **Adapter wiring** — `seedProfile?: boolean` (default false) on both `OidcOptions` and `OneTapVerifyOptions`; `IdTokenClaims` gained the optional `name`/`given_name`/`family_name`/`picture` (used only for seeding, never for authorization). Wired after the successful-`signIn` / non-denied branch in `oidcCallback` and `googleOneTapVerify`.

- **Refresh-on-login extension — not built** (baseline suffices for hccs-funds), exactly as the spec said to leave it.

- **Tests** — 11 cases in `test/oidc.test.ts`: gate-method unit tests (name split incl. `given_name`/`family_name` preference, no-clobber, avatar-failure → name-only, timeout abort → name-only, no-store no-op) and handler-integration tests (`oidcCallback` seeds and the subject is live on the next `authenticate`; `seedProfile` off writes nothing; One Tap parity). 342 pass; typecheck + build green.

**Downstream (hccs-funds):** the two-line app change is now unblocked — bind `profiles: d1ProfileStore(env.DB)` and pass `seedProfile: true` in its `oidcConfig`; the existing `<WhoamiChip>` then renders each member's Google name + face with no further change.
