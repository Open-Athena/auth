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
