# Grant `rotate`: re-key a leaked share link without losing its identity

*(Requested by marin-gcs-usage, 2026-09-19, over the cross-session channel. Agent tokens already rotate via mgu's `/api/token`; share links had only revoke/disable/enable/PATCH — no way to re-issue a link that had been shared too broadly.)*

## What it does

`gate.rotate(id, { endSessions? }, nowMs?)` mints a new token, swaps `token_hash` on the *same* grant row, and returns the raw token once (like `mint`). The grant's subject, scopes, expiry, redemption count, and audit history are untouched — only the key changes. The old `?key=` link stops resolving on its next use. Returns `{ grant, token }`, or `null` if the grant does not exist or is revoked (revocation is terminal — a revoked link can never be re-keyed back to life).

Two modes, because "rotate" covers two threat models (mgu settled this):

- **re-key only (default).** Sessions already minted from the old link keep working. The routine "this got shared more widely than I meant; re-issue it" case. `revoke` remains the nuclear option for "kill everything".
- **`endSessions: true`.** Also boots sessions already minted from the grant — the "the link *leaked*, get whoever's inside out" case — *without* revoking the grant, so the freshly issued token still mints working sessions.

Default is **re-key-only**: it's the non-destructive reading, and `revoke` already exists for the all-in case. `endSessions` is the opt-in for a suspected compromise.

## The `endSessions` mechanism (session `iat` + a grant epoch)

Grant sessions re-join their grant row on every request (that's what makes `revoke` instant), so booting a subset of them needs a per-session timestamp compared against a per-grant epoch:

- **Session `iat`.** `SessionClaims` gains `iat` (issued-at, epoch seconds), set by `signSession`. `verifySessionClaims` returns `{ sub, iat, exp }`; `verifySession` stays a thin `sub`-only wrapper so the storage-free-state callers (OIDC `state`, One Tap nonce) are unaffected. Cookies signed before `iat` existed decode with it absent — reported as `iat: 0` (the oldest possible), so an epoch check conservatively boots an un-datable session, which is the safe reading for a compromise.
- **Grant epoch.** `grants.sessions_invalid_before` (nullable, migration `0011_grant_rotate.sql`). `rotate({ endSessions: true })` stamps it with `nowS`; a plain re-key leaves it null. The store's `rotate` uses `COALESCE(?, sessions_invalid_before)`, so a later plain re-key never clears an epoch a prior `endSessions` rotation set.
- **The check.** In `authenticate`'s grant-session path, after re-joining the grant: if `grant.sessionsInvalidBefore != null && claims.iat < grant.sessionsInvalidBefore`, the session is denied (`reason: 'rotated'`, distinct from `revoked`/`expired`). The token-redemption path is untouched, so a session minted from the freshly rotated token (`iat >= epoch`) passes.

## API surface

- **`gate.rotate(id, opts?, nowMs?)`** → `{ grant, token } | null`. Logs a `rotate` event (`reason: 'end-sessions'` when booting, else null).
- **`POST <basePath>/grants/:id/rotate`**, body `{ endSessions?: boolean }` → `{ id, token }`. Admin + `scopeToCreator`-gated exactly like `revoke` — **404, not 403**, for a grant that isn't the caller's, so ids stay unconfirmed. `404 { error: 'not found' }` if the grant is missing/revoked.
- **`GrantStore.rotate(id, newTokenHash, sessionsInvalidBefore)`** — single-statement swap of `token_hash` (+ epoch via COALESCE), guarded on the grant existing and unrevoked; returns the updated grant or null. Implemented in `d1GrantStore` and `memoryGrantStore`.
- New exports: `verifySessionClaims` (session codec), `AccessEventKind` gains `'rotate'`.

## Deviations from the original directive

- **Store signature dropped the redundant `nowS` param.** The directive sketched `rotate(id, newTokenHash, sessionsInvalidBefore, nowS)`, but `sessionsInvalidBefore` already carries the instant (`endSessions ? nowS : null`), so a separate `nowS` would be unused. The store method is `rotate(id, newTokenHash, sessionsInvalidBefore)`; the gate computes the epoch and logs with its own `nowS`.

## Not built

- **Per-session revocation** (boot one specific session, not all pre-epoch ones). The epoch is a coarse "everyone before now" cut, which is what a rotation wants; targeted logout is a different feature.
- **Re-key notification.** Handing the new token to the intended recipient is the caller's job (same as `mint` — the raw token is returned once and never again).
