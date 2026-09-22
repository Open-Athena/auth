# A DB-table allowlist the SSO policy can consult

*(RW + session, 2026-09-22. From the hccs-funds thread: "gate `funds.hccs.dev` to board@ and jack@ … can /admin show the current allowed users? what would it take to understand GWorkspace groups?" The hardcoded roster in each app's `gate.ts` is the thing to dissolve.)*

## Problem

Today an app's allowlist is a literal array in code (`BOARD`, `STAFF`, `ADMINS` in hccs-funds' `gate.ts`), so changing who's allowed is a code edit + redeploy. `overview.md` already named the alternative ("allowlist: domain-match or DB table?") and `policy.ts` already left the seam open — `EmailPolicy` is `(email) => scopes | null | Promise<…>`, so a table-backed policy was always allowed. What was missing was the *store*, the *policy factory* that reads it, and a *management surface*.

This is also the substrate the group story needs: whether membership arrives by hand, by a `board@` directory sync, or (later) a SAML assertion, it lands in **one** table the policy reads. See [`saml-groups.md`](../saml-groups.md) for the "groups, live from the directory" tier that writes into this same store.

## What shipped

**Core is IdP-agnostic and holds no directory credential** — the package never talks to Google Admin SDK. It provides the table, the policy, and the CRUD; an app fills the table however it likes.

- **`migrations/0012_allowed_emails.sql`** — `allowed_emails(email PK, scopes, source, note, added_by, updated_at)`, plus an index on `source`. Email lowercased on write; `scopes` uses the same space-separated codec as `grants.scopes`.
- **`AllowlistStore`** (`core/store.ts`) — `lookup` (the hot path), `list`, `put` (upsert), `remove`, and `replaceSource(source, entries)`.
  - `source` is provenance: `manual` for a hand-added row, `sync:<group>` for one a directory sync owns.
  - **`replaceSource` is the sync primitive**: one transaction deletes every row of a source and re-inserts the current membership, so a sign-in mid-sync never sees the group momentarily empty, and a `board@` pull never clobbers a hand-added guest. It refuses an `entries` row whose `source` differs from the argument, so a sync can't write into a source it doesn't own.
- **`d1Allowlist(db)`** (`adapters/d1.ts`) — the D1 implementation; `replaceSource` uses `db.batch` (the test shim gained a transactional `batch`).
- **`allowlistPolicy(store, { scopes? })`** (`core/policy.ts`) — an async `EmailPolicy`. Default: each row carries its own scopes. `{ scopes }`: ignore the row's scopes and grant a fixed set to every listed identity (the "membership is the whole decision" case). Composes like any other: `firstMatch(adminPolicy(ADMINS), allowlistPolicy(store))`.
- **`<basePath>/allowed` admin routes** (`core/routes.ts`, gated by `adminScope`) — `GET` (list), `POST`/`PUT` (add/update a `manual` row, attributed to the admin), `DELETE /allowed/:email` (remove). Wired by a new `allowlist?` route option; 501 without it.
  - **Management is kept separate from enforcement on purpose.** Mounting the editor (`allowlist` route option) does *not* change who gets in; an app opts the table into authorization *separately*, by putting `allowlistPolicy(store)` in its `policy`. So "who can edit the list" and "does the list grant access" are two deliberate wirings, not one.
- **`AllowlistPanel`** (`react/`) — unstyled, prop-driven (every string and class a prop, like the other panels): list, add, remove, with a `manual`/`synced` provenance tag. `defaultScopes` lets the add form skip a scopes field.

## Boundary: the package does not sync directories

The Google Directory→table sync (an app's `scripts/sync-board.mjs`, holding *that app's* Google admin credential) stays out of the package, for the same reason `oauth-client-iac.md` kept OAuth-client provisioning out: it's IdP-management-plane code with a standing credential, and baking it in would couple this runtime-agnostic library to one IdP. The package gives the store + policy + panel; the app gives the sync and its creds. `replaceSource` is the contract between them.

## Acceptance (all covered by `test/allowlist.test.ts`, 17 tests)

- [x] `lookup` returns row scopes for a member, null for a stranger; case-folded on write and lookup.
- [x] `put` upserts; `list` is ordered; `remove` reports whether a row existed.
- [x] `replaceSource` swaps only its own source, leaves `manual` rows, and rejects a mismatched-source entry.
- [x] `allowlistPolicy` returns row scopes by default, a fixed set under `{ scopes }`, null for non-members, and composes under `firstMatch` behind `adminPolicy`.
- [x] `GET /allowed` lists for an admin, 401s anonymous, 403s an authenticated non-admin, 501s with no store wired.
- [x] `POST /allowed` adds a `manual` row attributed to the admin; 400s a bad email or non-array scopes.
- [x] `DELETE /allowed/:email` removes by (encoded) address and reports whether a row was there.

## Deliberately out of scope

- **The directory sync itself** — app-side, per the boundary above.
- **Auto-composing `allowlistPolicy` from the `allowlist` route option** — would make mounting the editor silently grant access. Kept as two explicit wirings.
- **Live directory groups in the token** — that's [`saml-groups.md`](../saml-groups.md), and it writes into this store rather than replacing it.
