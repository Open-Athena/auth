# Edit a share link's scopes after minting

**Status:** done. `PATCH /grants/:id` takes `scopes`, and `<GrantCard>` / `<GrantsPanel>` take `editScopes`.

How the result answers what this left open, or differs from it:

- **Authority:** holds, because minting doesn't limit scopes to the minter's own, so a delegated creator could already mint any set. The same goes for `*`. Such a link passes `hasScope` for anything, the admin scope included, as it always could from minting.
- **Validation is stricter than minting:** each name must have no space or comma, because the column is space-separated and `a b` would come back as two scopes. Repeats collapse.
- **Allowlist:** left alone, as suggested. A card with `allowlist` and a bound email says so.
- **Unoffered scopes** stay listed as checkboxes, so they survive a save and can still be removed on purpose.
- **Saves on each click**, with the last checked box disabled.
- **The audit reason** is `scopes; scopes a b -> b c`, and just `scopes` when nothing changed.
- **`ui.css`:** the panel now has its own surface. Found while checking this: on a light-only host in OS dark mode, the default ink was white on white.
- **The demo doesn't use it:** it offers one scope, so there's nothing to toggle.

*(Requested from `jobs.oa.dev`, `~/c/oa/jobs`, 2026-11-05.)*

## Context

`jobs.oa.dev` serves job descriptions, one scope per JD, through `<GrantsPanel>`. The admin wants a checkbox per JD on each existing link, to add or remove a role from a link already sent to someone. Today `PATCH /grants/:id` refuses `scopes` (`src/core/routes.ts`: "`scopes`/`createdBy` are not negotiable after minting"), so the only route is minting a new link and sending a new URL.

This belongs here rather than in an app-side overlay table. `resolveClaims` re-joins the grant on every request, so a changed `scopes` column already takes effect on the next request, with no session work. An overlay would have to duplicate the grant's lifecycle and would show the wrong scopes in `<GrantCard>`.

## Requirements

### Core

- Add `scopes` to `GrantPatch` (so also `GrantEdit` and `GrantUpdateInput`), and to `d1GrantStore.update` via `formatScopes`.
- Accept it in the `PATCH` whitelist, and rewrite the comment there. `createdBy` stays non-negotiable.
- Validate as minting does: a non-empty array of strings, else 400. A revoked link gets 409, as binding an email does.
- Authorization is the same `ownedGrant` check as other edits. Whoever could mint a scope can already grant it, so this adds no new authority. Confirm that holds for delegated (non-`adminScope`) creators, and for `ALL_SCOPES`.
- Audit: changing scopes writes an event recording the old and new sets. Who can see what is the thing an admin will later want to reconstruct.

### Client and React

- `client.grants` can send `scopes` on update.
- `<GrantCard>` gets scope checkboxes behind an explicit opt-in prop (e.g. `editScopes`), so `transcripts.oa.dev` doesn't gain this implicitly. At least one must stay checked.
- A scope on the grant that's no longer in the app's offered list must survive a save, not be silently dropped.
- Labels overridable, as elsewhere in `cardLabels`.

### Tests

- A session redeemed before the edit: loses a removed scope and gains an added one on its next request, without re-redeeming.
- Empty, non-array and non-string `scopes` get 400; a revoked link gets 409; nothing changes in those cases.
- A non-owner can't edit.
- The audit event carries both sets.
- `<GrantCard>`: no checkboxes without the prop; unoffered scopes preserved on save.

## Open question: the allowlist

Minting with `allowlist` copies the link's scopes to the email's `allowed_emails` row, so narrowing a link wouldn't narrow what that person gets by signing in. `jobs.oa.dev` doesn't use `allowlist`, so it doesn't need this settled. Pick whichever is right for the library. Leaving the allowlist alone and saying so in the UI seems safest, since a row can have other sources.

## Not in scope

- Per-scope expiry or per-scope activity.
- Making "disabled" end existing sessions. `jobs.oa.dev` enforces that itself in `authenticate()` (`worker/index.ts`). It may be worth a library option later, but it's separate.

## Downstream

`jobs` pins `github:Open-Athena/auth#<dist sha>`, currently `4a05ff6`. When a dist build is out, tell the `jobs` session the SHA. `jobs` then bumps the pin, passes the prop in `admin/src/Admin.tsx`, and adds its own test that a link's JDs change live.
