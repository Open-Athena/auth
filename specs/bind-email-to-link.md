# Bind an email to an existing link

## Why

An admin mints a link for someone by name and sends it before knowing their address. Later they learn it and want what minting with an email gives: the link is that person's, and the person has an account (Google / emailed-code sign-in). Today the only route is to revoke and re-mint with an email, which means sending a new URL.

That also breaks the session the recipient already has. The goal is to promote the holder's existing link session(s) in place, with nothing re-sent and nothing for them to do.

First consumer: gcs.oa.dev's admin links table (Open-Athena/disky `site/src/AdminPage.tsx` `HolderCell`), where a link was minted for "Ben Kolligs" with no email.

## What exists

- **Minting.** `POST <base>/grants` takes `email` (stored on `grants.email`) and `allowlist: true`. With both, `allowForLink(allowlist, email, scopes, {note, addedBy})` adds or widens the address's `allowed_emails` row, and the response carries `allowed: {email, status}`.
- **Editing.** `PATCH <base>/grants/:id` (`routes.ts`, whitelisted fields) and `gate.update(id, GrantEdit)` change `name`, `note`, the expiry, the redeem cap, the session TTL, `subjectName` and `avatar`.
  - Nothing can set `email`: `GrantPatch` (`types.ts`) has no `email` field.
- **Sessions follow the grant.** A grant session's `sub` is `g:<grant_id>` (`session.ts`), and it re-reads its grant on every request (`gate.update`'s doc). So a grant whose `email` changes is, on its holder's next request, an email-bound link session:
  - `principalEmail(auth)` returns it;
  - `mayEditProfile` admits it under `allowGrantSelfEdit`;
  - apps that key identity off `auth.grant.email` see it too (gcs's `identify` → `/api/me`, `user=me`, admin rows).

  No cookie re-issue is needed. **Verify this holds in every store, the retained-session (`d1-retained`) path included.**

## Change

1. **`GrantPatch.email?: string | null`**, written by every store's `update`: D1, the retained D1 adapter if it has its own `update`, and the in-memory test store.
2. **`PATCH <base>/grants/:id` accepts `email` and `allowlist`:**
   - `email`: trimmed and lowercased; `isEmailish` or 400. `null` or blank clears it.
   - `allowlist: true` with a non-null email: checked before the update, as at mint (501 without an allowlist store, 400 without a valid email). After the update, `allowForLink(allowlist, email, grant.scopes, {note: 'with link "<name>"' | 'with a share link', addedBy})`, and `allowed` is returned beside `grant`, as at mint.
   - The same `ownedGrant` check as the other edits. Binding an identity to a link is an admin's attestation that its holder is that person, which is exactly what minting with an email already is.
3. **Audit.** The `update` log reason already lists the edited keys, so `email` and `allowlist` show up. A rebind (non-null → a different non-null) also records the prior address, so "who did this link belong to" stays answerable.
4. **Revoked links:** refuse (409). Binding an address to a dead link would only create an account by the back door; use the allowlist panel for that.
5. **No Gravatar auto-fetch on bind.** Mint fetches one when no avatar is given. On edit, the holder may already have a face the admin chose; `avatar` stays an explicit field.

## Tests

- Bind on a link that has an existing grant session: before, `whoami` shows no email; after the PATCH, the same cookie's `whoami` shows the email; `principalEmail` too.
- Exercise both the plain and the retained-session stores.
- `allowlist: true`: a row is `added`; an existing narrower row is `widened` and becomes `manual`; one that already covers the scopes is `already`, as `allowForLink` does at mint.
- Validation: a bad email is 400; `allowlist` without an email is 400; no allowlist store is 501; a revoked link is 409; a non-owner is refused as for other edits.
- Clearing (`email: null`) un-binds the session on its next request and leaves the allowlist row alone, as revoke does.
- The audit row's reason and, on a rebind, the prior email.

## Consumer (disky, not this repo)

gcs's `HolderCell` gains an email input, shown when the link has no email, with an "also create their account" checkbox defaulting on (`allowlist: true`), mirroring the mint form. It ships after this lands in a dist that disky's `site/package.json` pins.
