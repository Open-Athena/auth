# Google group → allowlist sync, in the package

*(RW + session, 2026-09-23. Closes the loop from [`done/allowlist-store.md`](./done/allowlist-store.md) ("the package does not sync directories") and [`saml-groups.md`](./saml-groups.md). After establishing that nothing pushes group changes to a custom app — Google's SSF/CAEP role is *receiver*, session-revocation only, closed beta — and that a ≤1 h revocation window is the industry norm (a token lifetime; Entra CAE's "within minutes" is best-in-class and doesn't fast-path group changes either), the decision is: a periodic pull into `allowed_emails` **is** the right-sized "live groups" tier, and the library should make it turnkey rather than leave it to each app.)*

## Reversal of the "no directory code" boundary

`allowlist-store.md` kept the sync out of the package because it is "IdP-management-plane code with a standing credential". That reasoning still holds for *provisioning* (creating the service account, granting it read access — that's `gcloud`/Terraform, below), but not for the *runtime*: minting a service-account token is standard WebCrypto RS256 + one `fetch`, and listing a group is one paginated GET. Zero dependencies, WinterCG-pure, runs on bare Workers. Leaving ~150 lines of "get it right once" code to every consumer is the opposite of 90/10.

The library still holds no credential: the app passes the SA key (a Worker/Pages secret or a GHA secret) at call time, exactly as it passes the OAuth client secret today.

## Auth models (verified 2026-09-23)

One token helper covers both, because the choice is a single optional JWT claim:

| Model | How the SA gets read access | IaC-able | JWT `sub` |
|---|---|---|---|
| **Role-assigned SA** (recommended) | Assign a Workspace admin role (Groups Reader) to the SA — Admin console *Assign service accounts* (by email) or Admin SDK `roleAssignments.insert` (by SA unique ID; what Terraform's `googleworkspace_role_assignment` wraps) | yes | none — SA acts as itself; audit log shows the SA |
| **Group owner** (lightest) | Make the SA an OWNER of just the group(s) it reads: `gcloud identity groups memberships add --group-email=board@… --member-email=<sa> --roles=OWNER` | yes (`google_cloud_identity_group_membership`) | none |
| **Domain-wide delegation** (legacy) | Authorize the SA's client ID + scope under *Security → API controls → Domain-wide delegation*, impersonate an admin | console-only grant | the impersonated admin |

The first two need **no domain-wide delegation and no impersonation** — the "intrinsic complexity only" version. DWD is supported (`subject` option) for orgs already wired that way, and is the one path with a console-bound step.

Bootstrap caveat: whoever runs the IaC (or `gcloud`) that grants the SA its role/ownership must already be a Workspace admin or group owner. That's the same one-time human step every provisioning story has; after it, membership changes are pure Workspace admin (edit the group), and nothing else needs touching.

## Read APIs

Both supported; the SA's role/ownership authorizes either.

- **Cloud Identity** (default — see the live-verification addendum): `groups:lookup?groupKey.id=…` → `GET cloudidentity.googleapis.com/v1/{name}/memberships?view=FULL&pageSize=500`; scope `cloud-identity.groups.readonly`. Direct members only (transitive search is Enterprise/Premium-gated); keep `type === 'USER'` (`view=FULL` is required — BASIC omits `type`).
- **Admin SDK Directory** (`api: 'directory'`): `GET admin.googleapis.com/admin/directory/v1/groups/{group}/members?includeDerivedMembership=true&maxResults=200` — flattens nested groups on every Workspace edition; scope `admin.directory.group.member.readonly`. Keep `type === 'USER'`, drop `status === 'SUSPENDED'`. Needs an admin-role or DWD SA.

## Shape

New `adapters/google-directory.ts`, exported as `@open-athena/auth/google-directory`. Zero deps; `core/` untouched.

- `googleAccessToken({ key, scopes, subject?, fetch?, nowMs? })` — parse the SA key JSON (`client_email`, `private_key`, `token_uri`), import the PKCS#8 PEM via `crypto.subtle.importKey`, sign a JWT-bearer assertion (`iss`, `scope`, `aud`, `iat`, `exp = iat + 3600`, optional `sub`) with RSASSA-PKCS1-v1_5/SHA-256, POST it to `token_uri`, return `{ accessToken, expiresAt }`. Throws on a non-2xx token response (a provisioning error, not a runtime state).
- `listGroupMembers(group, { token, api?, fetch? })` — paginate the chosen API, return lowercased user emails, sorted and de-duplicated. Throws on non-2xx.
- `syncGroupsToAllowlist(store, { key, groups: [{ group, scopes }], api?, subject?, fetch?, nowMs? })` — one token, then per group: list → `store.replaceSource('sync:<group>', entries)` with `addedBy: 'sync'`. Returns `{ group, count }[]`. A failed listing throws *before* any `replaceSource` for that group, so a transient API error never empties a group.
- **Scopes constants**: `DIRECTORY_SCOPE`, `CLOUD_IDENTITY_SCOPE`.

### Trigger recipes (README, not code)

- **Worker Cron Trigger**: `[triggers] crons = ["*/15 * * * *"]` + `scheduled()` calling `syncGroupsToAllowlist(d1Allowlist(env.DB), { key: env.GOOGLE_SA_KEY, groups })`. Pages Functions have no cron, so a Pages app uses a sibling Worker bound to the same D1, or:
- **GitHub Actions schedule**: `wrangler d1 execute` is the wrong tool (it can't run TS); instead a `scripts/sync-groups.mjs` in the app calls the same helper against the D1 HTTP API — or simplest, hits an admin-only `POST <base>/allowed/sync` route the app mounts. (Not built here; noted as the follow-up if a Pages consumer wants GHA over a sibling Worker.)

Revocation lag = cron interval + one request, because `allowlistPolicy` is re-evaluated per request.

### Provisioning recipe (README)

```bash
gcloud iam service-accounts create group-sync --project $PROJECT
gcloud services enable admin.googleapis.com --project $PROJECT      # or cloudidentity.googleapis.com
gcloud iam service-accounts keys create sa.json --iam-account group-sync@$PROJECT.iam.gserviceaccount.com
# read access — pick one (needs a Workspace admin / group owner running it):
gcloud identity groups memberships add --group-email=board@example.org \
  --member-email=group-sync@$PROJECT.iam.gserviceaccount.com --roles=OWNER
# …or assign the Groups Reader admin role in the Admin console / via roleAssignments.
wrangler secret put GOOGLE_SA_KEY < sa.json
```

## Acceptance

- [x] `googleAccessToken` produces a JWT-bearer assertion the token endpoint can verify with the SA's public key, with exactly the expected claims (and `sub` only when `subject` is given); returns the access token; throws on a 4xx.
- [x] `listGroupMembers` follows `nextPageToken` on both APIs, keeps only active `USER` members, lowercases, sorts, de-dups; Cloud Identity path does `lookup` first.
- [x] `syncGroupsToAllowlist` writes `sync:<group>` rows via `replaceSource` with the configured scopes, leaves `manual` rows alone, and does not touch the store when listing throws.
- [x] `allowlistPolicy` over the synced store admits a member and denies a removed one on the next sync.
- [x] Exported from `package.json` `exports` as `./google-directory`; `verify-dist` covers it.
- [x] README: the recipe above, and the Google-groups stance updated (no longer "app-side").

## As built (2026-09-23)

`src/adapters/google-directory.ts`, exported as `@open-athena/auth/google-directory`; `test/google-directory.test.ts` (10 tests: assertion claims verified against the SA public key, `sub` only with `subject`, key-as-string, both APIs paged and filtered, sync writes/leaves-manual/denies-after-removal/untouched-on-error). Differences from the shape above:

- `googleAccessToken` also returns `clientEmail`, and sync rows carry `addedBy: <client_email>` rather than a bare `'sync'` — the audit trail names the credential.
- The Cloud Identity path pages at `pageSize=500`; Directory at `maxResults=200` (its max).
- `syncSource(group)` is exported so an app can address a group's rows (`store.replaceSource(syncSource(g), [])` to drop one).
- The GHA-schedule trigger for Pages apps is documented as "sibling Worker or scheduled Action" and not built; an admin `POST /allowed/sync` route stays a follow-up if a consumer wants it.

## Addendum (2026-09-23): `POST /allowed/sync` — Pages apps need no cron Worker

Both first consumers (hccs-funds, gcs) are Pages projects, so "sibling Worker with `[triggers] crons`" was the wrong default. `authRoutes(gate, { allowlist, sync: { run, token? } })` now mounts `POST <base>/allowed/sync`: gated by `adminScope`, or by `token` as a bearer (compared as SHA-256 hashes) so a scheduled GitHub Action `curl`s it with a `SYNC_TOKEN` secret. `run` is a plain callback (typically `() => syncGroupsToAllowlist(store, …)`), so `core/routes.ts` stays ignorant of Google. A throwing `run` → 502 `{ ok: false, error }`, table untouched. `<AllowlistPanel sync />` adds a "Sync now" button that reports the per-group counts. Tests: `test/allowlist.test.ts` (5) + `test/react/allowlist.test.tsx` (3).

## Addendum (2026-09-24): live verification against HCCS — Cloud Identity is the default

First real run (`group-sync@gws-auth-494405`, an OWNER of `board@hudcostreets.org`, no admin role, no DWD), via `scripts/verify-group-sync.mjs`:

- **A just-minted SA key fails for ~30 s** with `invalid_grant: Invalid JWT Signature` — propagation, not a signing bug. The same key succeeded 30 s later. `verify-group-sync` is the right tool precisely because it separates "token ok" from "group readable".
- **Admin SDK Directory refuses a group-owner SA**: `403 Not Authorized to access this resource/api`. It needs a Groups Reader admin role or DWD.
- **Cloud Identity honours the owner**, but its default `BASIC` view omits `type`, so the USER filter dropped every row (`0 members`) — fixed by `view=FULL`. With that: 11 members, the SA itself (`SERVICE_ACCOUNT`) correctly excluded.

So the adapter's default flipped to `api: 'cloud-identity'` (`directory` stays opt-in for admin-role/DWD setups that want nested groups flattened), error messages now carry Google's response body, and the key went straight into `hccs-funds`'s `GOOGLE_SA_KEY` Pages secret from stdin.
