# Retrievable link keys: staff can copy a link again after minting

Requested from `jobs` on 2026-11-15. Today a grant's token is shown once and only its hash is stored, so a lost link can only be replaced by Rotate, which breaks the links already sent. Ryan has wanted a link back twice, and in `jobs` it's the normal workflow: mint once, come back to the dashboard to copy per-JD links for emails.

## Why this is OK for share links

A share link is a bearer token made to be handed to outside people. It already lives in the minter's sent mail, the recipient's inbox, chat apps and their servers. Keeping a copy server-side adds little exposure next to that, and what a link opens is bounded by its scopes, its expiry and its max redemptions, and it can be disabled or revoked. The thing a plaintext copy adds is "anyone who can read the auth DB can use every live link", so don't store it in plaintext:

- **Encrypt at rest** with a key from a Worker secret (e.g. AES-GCM, key derived via HKDF from a new `GRANT_KEY_SECRET`, or from `SESSION_SECRET` with a distinct `info`). A D1 dump or backup alone then reveals nothing; the hash stays the lookup path, unchanged.
- **Only staff/admin** can read it, through an explicit endpoint (`GET /api/auth/grants/:id/token`), never in the grants list payload, and every read goes to the audit/access log.
- Rotate replaces the stored copy; Revoke deletes it.

## Shape

- Migration: `grants.token_enc TEXT` (nullable: null = not kept).
- Mint option `keep: boolean`. An app-level default on `GrantsPanel`/the server (`keepTokens: true | false`, default `false` so other apps keep today's behavior); `jobs` will set `true`.
- Mint form: a checkbox for the non-default choice. With `keepTokens: true` it reads "Forget the key after this (it's shown only once)", unchecked by default.
- `GrantCard`: a link whose key is kept shows its links (the same `buildLink` rows, and whatever lands from `grant-links-beside-scopes.md`) on demand, e.g. a "Show links" button that fetches the token; a link whose key isn't kept keeps today's "Link shown once at mint. Rotate it for a fresh one" note.
- A way to keep an existing link's key without rotating it: staff paste the key into the card ("Keep this link's key"); the server checks it hashes to the grant's stored hash before saving it. Ryan has a live link (Hilary Mason's, in `jobs`) he wants to keep this way, since rotating would break links already sent.

## What `jobs` will do after this lands

Set `keepTokens: true`, apply the migration, paste Hilary's key into her card; bump the dist.

## Status: done

- Migration `0006_kept_tokens.sql`: `grants.token_enc TEXT`. `Grant.kept` (staff-only) says whether one is kept.
- Sealing (`src/core/token-vault.ts`): AES-GCM, key from HKDF-SHA-256 over `tokenSecret` (default the gate's `secret`; whoever holds that can already sign a session for any link, so a separate secret adds little, but one can be passed), info `oa-auth kept grant token v1`, the grant id as associated data (a sealed key copied to another row won't open), stored as `v1.<b64u(iv‖ciphertext)>`. The hash stays the lookup path. A key that won't open, or no longer hashes to the row's `token_hash`, reads as not kept.
- Gate: `keepTokens` (default false) and a mint's `keepToken`; `rotate(id, { keepToken })` keeps the new key if the old one was kept unless told otherwise (the store's rotate clears `token_enc` in the same statement); revoke clears it; `revealToken(id, actor)` logs `reveal`; `keepToken(id, token | null, actor)` keeps a pasted key only if it hashes to the current `token_hash` (checked in the UPDATE's WHERE) and logs `keep` (`reason: 'forget'` for null).
- Routes: `GET /grants/:id/token` (404 `not kept`), `PUT` with `{ token }` accepting a bare key or a whole link (400 "that isn't this link's current key"), `DELETE`. Same admin and ownership checks as the other grant routes; the list payload never carries a key.
- Client/UI: `client.grants.token/keepToken/forgetToken`; controller `reveal` (puts the key in the snapshot as `source: 'reveal'`), `keepToken`, `forgetToken`. `GrantsPanel`/`GrantMintForm` `keepTokens`: the mint checkbox offers the non-default choice ("Forget the key after this (it's shown only once)" when kept by default). `GrantCard`: "Show links" plus a "forget key" confirm for a kept key, whose links then render with the scope-row placement from `grant-links-beside-scopes.md` and a "This key is kept (sealed)" note; otherwise the shown-once note with "keep this link's key" (paste the key or the link).
- Deploys sharing `migrations/` (the broker and the demo) need `db:remote` before their next deploy, as `0006` adds a column the grant queries read.
