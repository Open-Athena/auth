# `login.oa.dev` should pass the user's photo to the apps signing in through it

*(Requested from `jobs.oa.dev`, `~/c/oa/jobs`, 2026-11-05.)*

## Context

Users signing in to `jobs.oa.dev` through the broker get initials rather than their Google photo. `specs/oidc-provider.md` already lists this as a gap ("`picture` for `asset://` / `data:` avatars (only `https:` URLs are passed through today)"):

- The broker's own `oidcCallback` seeds its profile from Google, copying the photo inline as a `data:` URI.
- `claimsFor` in `src/provider/routes.ts` only emits `picture` for an `https:` avatar, so the photo stops at the broker.

This is from reading the code. I didn't confirm it against the broker's production rows.

## Requirements

- An app using `openid email profile` gets a `picture` claim it can fetch server-side, without bloating every token.
- Keep the privacy property from `oidc-profile-seed.md`: don't hand out a live `lh3.googleusercontent.com` URL as something browsers render. A broker-hosted URL looks like the natural fit (e.g. `https://login.oa.dev/avatar/<unguessable id>`), since the relying party's `seedProfileFromClaims` copies it inline on its side anyway. Your call on the mechanism.
- People already in the broker's `profiles` with a photo should work without re-consenting. Check the case where the row predates the fix.

## Downstream

`jobs` sets `seedProfile: false` in `worker/index.ts`, because a name-only seed writes a row and then blocks any later seed. When this is live, tell the `jobs` session; it removes that line, and new sign-ins pick up photos.

Other relying parties (`disky-gcs-dev`) that have already seeded a name-only row won't get a photo from `seedProfileFromClaims`, which skips existing rows. It may be worth handling that here.

## As built

**Status: done in code; not deployed.** Production rows were not inspected, so the context above ("from reading the code") is still unconfirmed against them.

### Mechanism: `/oidc/picture/<ticket>`

`claimsFor` turns a stored `data:` or `asset://` face into `<issuer>/oidc/picture/<ticket>` (`src/provider/picture.ts`). The ticket is AES-GCM over `{email, client, expiry}`, keyed from `subjectSecret`.

This differs from the spec's example of a broker-hosted URL with a stable unguessable id, in that the URL is short-lived and there is no table:

- **Lifetime**: it expires with the token carrying it (`tokenTtlS`, 300 s by default). `seedProfileFromClaims` copies during the sign-in callback, so nothing needs it longer. A permanent URL would be a standing public address for a face, in whatever an app logs.
- **Revocation**: expiry does most of it. Each request also re-checks the client and `policy` / `allow`, and reads the current row, so a removed photo, a delisted person or a disabled client gets a 404 at once.
- **Who can fetch**: anyone holding the URL until it expires, with no cookie or secret, because `copyAvatar` is a plain GET. Encryption keeps the email out of the URL and out of logs.
- **No migration**: nothing new to deploy but code. A bad ticket costs no database read.
- **Cost**: a relying party that stores the URL or renders it in a browser gets a dead link, and `cross-origin-resource-policy: same-origin` blocks the render outright. All the apps here use `seedProfileFromClaims`. A third-party RP would need a stable URL, which would be a change here.

**Response**: the type comes from sniffing the bytes (`validateUploadedImage`), never from the `data:` label or the asset record. Anything else, SVG included, is the same 404 as every other refusal. Headers are `nosniff`, `no-store` and `content-security-policy: default-src 'none'; sandbox`.

`https:` rows still pass through as they did. No writer in this package stores one (`putProfile` and the seed both copy), so this only matters for rows written by hand or by another store.

**Rows that predate this** work with nothing done to them: the claim is computed from the row at token time, so there's no re-consent and no backfill for a broker row with a photo.

### Existing rows on the relying party

The spec flags that `seedProfileFromClaims` skips existing rows. Filling any row with `avatar IS NULL` isn't safe, because three different histories look identical: `{name, avatar: null, avatarSrc: null}` is a seed that found no photo, a person who cleared their photo, and a person who only ever set a name. Bringing back a photo someone removed is the worst of these outcomes, so the row needs to say which it is.

- **New marker**: a seed that gets no photo writes `avatarSrc: 'seed-pending'` (`AVATAR_SEED_PENDING`). No migration, since `avatar_src` is free text.
- **Retry**: later sign-ins retry the photo for marked rows only. The name is never touched (an edited name stays), and `updatedAt` isn't either, since it's the self-edit throttle's basis.
- **What ends it**: setting a photo or clearing one, both through `putProfile`. A name-only edit doesn't, because it says nothing about the photo.
- **A race**: the row is re-read after the copy, so a choice made during it wins. A small window remains between that read and the write, as `ProfileStore` has no compare-and-swap.
- **Also fixed**: one failed or slow Google fetch at first sign-in no longer means no photo forever, and `seedProfile: false` is no longer needed to avoid that block (the reason `jobs` set it).
- **Cost**: every sign-in on a marked row re-fetches, bounded by `avatarFetchTimeoutMs`. Only sign-ins pay it, not ordinary requests.

**Unmarked rows from before this stay as they are**, including `disky-gcs-dev`'s. Nothing in such a row distinguishes a cleared photo, so this needs a person's decision, per app, run once:

```sql
UPDATE profiles SET avatar_src = 'seed-pending' WHERE avatar IS NULL AND avatar_src IS NULL
```

A one-off statement rather than a standing option, because an option would keep overriding clears made after it was turned on. On the broker it's safe, as nothing there can clear a photo. In an app, it brings back the photo of anyone who cleared theirs.

### Differences from the request

- `jobs` still needs a bump to this package before dropping `seedProfile: false`; on the old version a failed copy would still leave a blocking row.
- A marked row fills at the next sign-in through `oidcCallback`, not on the next request, so people with live app sessions see initials until then.
- Apps copy with the inline cap (64 KB) unless they bind an `AssetStore`. A larger face (possible only on a broker with assets) stays `seed-pending` there.

### Not verified

No deploy was done. Fetching `login.oa.dev` from another Worker on the `oa.dev` zone wasn't exercised, though apps already reach its token endpoint the same way. The Google flow and Cloudflare's D1 were stood in for by an injected fetch and the SQLite shim.
