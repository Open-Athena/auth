# Self-serve profiles: a signed-in user sets their own name + face

*(Requested by marin-gcs-usage, 2026-09-18. Extends [`share-links-and-audit.md`](./share-links-and-audit.md) (the `subject_json` identity carried on a grant) and answers the open avatar question in [`auth-upstream-followups.md`](./auth-upstream-followups.md) §"avatar is never accepted from the form" — the sanctioned way to let a user supply their own face.)*

## Why

Two gaps, one shared answer.

1. **SSO principals have no identity to render.** `Auth` is `{ kind: 'sso'; email; admin; scopes }` — no name, no avatar. `<Avatar>`/`<WhoamiChip>` fall back to initials-of-email for every staff user, forever. There is nowhere for a signed-in person to say "I'm Ryan, here's my face."
2. **Grant subjects are admin-only and immutable.** `subject_json {first,last,email,avatar}` is set by the admin at mint (resolved server-side by `core/avatar.ts`) and never editable afterward — correctly, because a share link that renders the recipient's real face is what discourages forwarding. But it means the *only* identities the system knows are the ones an admin typed.

Every adopter (watchy, marin-gcs-usage, mortgage-viz, applitrack) will eventually want "let a signed-in user set their own display name and avatar," and each would otherwise reinvent it — including the one part that's easy to get wrong: **you must copy a user-supplied image server-side, never render a live third-party `<img src>`.** A remote `<img src>` on a page whose whole premise is private access leaks (referrer + "this person opened this page") to whatever host serves the image, on every render, and breaks when that host hotlink-protects or disappears. `core/avatar.ts` already solved exactly this for grants; this spec generalizes it to a self-serve, session-scoped surface.

This is still *gating*, not a profile system: display name + avatar for an authenticated principal, nothing more. No bios, no preferences, no social graph.

## What already exists (reuse, don't rebuild)

- **`core/avatar.ts`** — `resolveAvatar({ url | github | email }, { inline, maxBytes })` fetches the image server-side and returns either a validated URL or, with `inline: true`, a `data:` URI (content-type must be `image/*`, never `image/svg+xml`; `≤ MAX_INLINE_AVATAR_BYTES = 64 KB`; injectable `fetch` for tests). `isSafeAvatarUrl` (https-only, no credentials), `isGithubHandle`, `gravatarUrl` (`d=404` so absence is knowable), `githubAvatarUrl`. This is the copy-server-side primitive; the self-serve flow calls it with the *user's own* source.
- **`Subject { first?, last?, email?, avatar? }`** and **`displayName(whoami)`** / **`<Avatar>`** (already prefer `subject.avatar`, fall back to initials, code-point-safe). The render side needs no change — it only needs the SSO branch to *carry* a `subject`.

The new work is: a place to persist a self-set profile, a route to edit it, wiring the SSO identity to read it, an upload path (the one source `avatar.ts` doesn't cover today), and an unstyled React panel.

## 1. Data model — `migrations/0008_profiles.sql`

```sql
CREATE TABLE profiles (
  email       TEXT PRIMARY KEY,   -- the verified principal (SSO, or magic-link-verified grant email)
  first       TEXT,
  last        TEXT,
  avatar      TEXT,               -- a data: URI (default) or an asset ref (asset://<id>) — never a live remote URL
  avatar_src  TEXT,              -- provenance for re-resolve/debug: 'upload' | 'url' | 'github' | 'gravatar'
  updated_at  INTEGER NOT NULL
);
```

Keyed by **email**, because that's the stable identity across sessions and the only thing an SSO id_token and a magic-link grant share. A profile is a property of the *person*, not of a session or a grant — sign in tomorrow on another device and your face follows you.

`avatar` holds a `data:` URI for the common case (≤64 KB, zero new infrastructure — the same inlining `core/avatar.ts` already does). Larger images / direct uploads use an optional asset store (§4); those rows hold `asset://<id>` and are served by the app from its own origin.

## 2. Identity wiring — SSO gains a `subject`

`Auth` grows the SSO branch a resolved subject:

```ts
| { kind: 'sso'; email; admin; scopes; subject: Subject | null }
```

On authenticate (per request, or at session mint with a short cache — same cadence as the grant re-join), look up `profiles[email]` and attach it as `subject`. `displayName`/`<Avatar>` then Just Work for staff, with no render-side change. A principal with no row is `subject: null` → initials, exactly as today. Grant identities are unchanged: their subject still comes from the grant (admin-owned).

## 3. Routes — `core/routes.ts`

- **`GET /api/profile`** → the caller's own `{ first, last, avatar }` (or `null`). Self only; never takes an email argument (no reading anyone else's).
- **`PUT /api/profile`** → body `{ first?, last?, avatar? }` where `avatar` is one of:
  - `{ upload: <bytes> }` (multipart) — the new path §4 adds;
  - `{ url: "https://…" }` — validated by `isSafeAvatarUrl`, then **copied** via `resolveAvatar({ url }, { inline: true })` (or to the asset store); the live URL is never persisted;
  - `{ github: "handle" }` / `{ gravatar: true }` — resolved via the existing helpers;
  - `null` — clear (back to initials).
- Both are gated to the **authenticated self**: `requireScope('self')`-shaped — any signed-in principal may edit their *own* profile, no admin scope needed. No route ever mutates another principal's row.

Display-name handling: trim, cap length (e.g. 80), strip control characters, no HTML/markup (it lands in text nodes and in `initialsOf`, which is already code-point-safe). Names are not unique and not validated for realness — they're self-asserted labels, and the audit log records the *email*, which is the real identity.

## 4. Uploads + the asset store (the one genuinely new adapter)

`core/avatar.ts` fetches URL/github/gravatar; it does not accept raw bytes. Add:

- **`core/avatar.ts` → `validateUploadedImage(bytes, { maxBytes })`** — content-type by magic-number sniff (not a trusted header), `image/{png,jpeg,webp,gif}` only, **never SVG** (scriptable), a decode/dimension sanity check, and a byte cap. Returns a normalized `{ type, bytes }` or throws. (Re-encode/EXIF-strip is desirable but needs an image codec in a Worker; see Open questions — v1 may ship sniff-and-cap without re-encode, which already closes the SVG/mislabel hole.)
- **`AssetStore` interface** (runtime-agnostic, in `core/`): `put(bytes, type) → id`, `get(id) → { bytes, type } | null`, `del(id)`. Default binding is **none** — profiles inline as `data:` URIs (≤64 KB) with zero new infra, matching the package's "core + adapters as a file boundary" discipline. Apps that want bigger avatars or to keep grant/profile rows small bind an adapter.
- **`adapters/r2.ts`** — the CF `AssetStore` over an R2 bucket. Served by an app Function `GET /avatar/:id` (long-cache, from the app's own origin — the whole point). This is the fourth adapter, peer to `d1`/`cf-access`/`resend`; it stays the only asset adapter until a non-CF consumer appears.

When a user replaces an avatar, delete the prior asset (`del`) so the store doesn't accrete orphans; inline (`data:`) rows need no GC.

## 5. Policy — who may self-edit

- **SSO / verified-email principals: yes.** They authenticated as themselves; editing their own label is safe and expected.
- **Grant (share-link) subjects: no, by default.** A share link's face is the admin's anti-forwarding signal; letting the recipient rewrite it (and letting a *forwarded* link rewrite whose identity it now shows) is exactly the "forwarding silently manufactures identities" hazard flagged in `auth-upstream-followups.md`. Gate behind an opt-in policy `allowGrantSelfEdit` (default `false`). A magic-link grant whose `email` has been verified is the gray case — treat it as SSO-equivalent (verified email) only once verification actually happened.

The `PUT /api/profile` handler therefore checks `auth.kind === 'sso'` (or a verified magic-link) before writing, and 403s a bare grant session unless the app opted in.

## 6. React — `src/react/ProfilePanel.tsx`

Unstyled, like the rest of `src/react/`:

- Renders the current `<Avatar>` + name; lets the user set first/last and choose an avatar source: **upload** a file, paste a **URL**, use their **GitHub** handle, opt into **Gravatar**, or **clear** to initials.
- Posts to `PUT /api/profile`; on success the `useWhoami` cache refetches so the chip updates in place.
- Export from `src/react/index.ts`. `<WhoamiChip>` gains an optional affordance to open it (a click target), so an app gets "click your face → edit it" for free.

No Gravatar-by-default anywhere (the privacy note in `Avatar.tsx` stands) — it's one opt-in source among several, chosen by the user for their own address.

## 7. Testing — `src/testing/`

- In-memory `profiles` store + in-memory `AssetStore`, so an adopter can test the route without D1/R2.
- `resolveAvatar` already takes an injectable `fetch`; assert that a `{ url }` set **persists a `data:` URI (or `asset://`), never the live URL** — the whole safety property, as a spec-shaped equality test (not a substring check): the stored `avatar` starts `data:image/` and the live host is never dereferenced on read.
- Upload validation: an SVG, an oversized image, and a text file mislabeled `image/png` each throw; a real PNG round-trips.

## 8. Adopter integration (marin-gcs-usage first)

1. Apply `0008_profiles.sql`.
2. Wire `/api/profile` (+ `/avatar/:id` if using R2) as Pages Functions over the existing gate; add the R2 binding only if opting out of inline.
3. Drop `<ProfilePanel>` into the user menu; SSO users now get a real name/face, grant recipients keep the admin-set one.
4. mgu already renders `subject.avatar` for grants, so the render side is a no-op — this only *adds* the SSO subject and the edit surface.

## As built (2026-09-19)

Implemented to spec; the deviations worth knowing:

- **Route path is `${basePath}/profile` (`/api/auth/profile`), not `/api/profile`.** The whole route surface lives under one `basePath` (`whoami`, `exchange`, `track`, …), and `authRoutes` returns `null` for anything outside it. Mounting profiles there keeps the surface coherent and the React default (`ProfilePanel` posts to `/api/auth/profile`) consistent. An adopter that wants a bare `/api/profile` mounts its own Function over the same `gate.getProfile`/`putProfile`.
- **`Auth`'s SSO `subject` is required (`Subject | null`), not optional.** Always present (null = initials), so the FE never branches on its absence. Existing SSO-shape assertions gained `subject: null`.
- **`AssetStore` lives in `core/assets.ts`** (with `assetUri`/`assetId` helpers), a sibling of `store.ts` rather than inside it.
- **Only uploads use the asset store.** URL/GitHub/Gravatar sources are always inlined as `data:` URIs (≤ `MAX_INLINE_AVATAR_BYTES` = 64 KB) — they're small and it keeps those paths storage-free. A bound `AssetStore` raises the cap for *uploaded* bytes only (`profileUploadMaxBytes`, default 256 KB → `asset://<id>`); without one, uploads also inline and stay at 64 KB.
- **A `fetch` is injectable on `GateOptions`** (for the server-side avatar copy), so the safety test can assert the live host is fetched exactly once (at write) and never on read.

### Open questions — resolved

- **Re-encode / EXIF strip: punted**, as the spec allowed. v1 is sniff-and-cap, which closes the SVG-script and mislabel holes (the ones that weaponize an avatar). Re-encode needs a wasm codec in a Worker; add it when a consumer needs GPS/metadata stripped.
- **Abuse / rate limiting: partial, no new infra.** Total avatar bytes per principal is inherently capped (one avatar, byte-limited on every source). Edit rate is throttled by `profileMinEditIntervalS`, a *durable* min-interval check against the row's `updated_at` — no counter store. A true rolling edits/minute window (which *would* need a counter store) was deliberately not built; the min-interval throttle covers the abuse case the open question named.
- **Grant self-edit for verified magic links: approximated.** There is no per-grant "verified" flag today, so `putProfile` treats a grant session as edit-eligible only when the app sets `allowGrantSelfEdit` *and* the grant is email-bound (`grant.email !== null`) — an anonymous/forwarded link has no principal to key a profile by. If an explicit verification signal is added later, gate on that instead.
- **Moderation: out of scope** (unchanged) — the admin grid can view/clear a row.

## Open questions (original)

- **Re-encode / EXIF strip on upload.** Ideal (drops GPS/embedded junk, neutralizes polyglots) but needs an image codec in a Worker (wasm) — weigh against v1 shipping sniff-and-cap-without-re-encode, which already closes the SVG-script and mislabel holes. Punt the codec unless a consumer needs it.
- **Abuse / rate limiting.** `PUT /api/profile` fetches a remote URL and/or stores bytes; cap edits/minute per principal and total avatar bytes per principal.
- **Grant self-edit for verified magic links.** Confirm the verification signal exists before treating a magic-link grant as SSO-equivalent for edit rights.
- **Moderation.** Out of scope for gating; if an app needs it, the admin grid (`/api/db`) can already view/clear a row.
