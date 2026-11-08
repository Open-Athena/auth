# Fresh Google Group snapshots for authorization

## Decision (2026-11-07)

Use the existing Google Directory adapter, but store each group's membership independently instead of overwriting an email's allowlist row. Authorization reads the snapshot on each request and denies scopes from missing, future-dated or stale snapshots. This supports overlapping groups and prevents an outage from preserving admin access indefinitely. It does not put membership into long-lived OIDC claims or change any deployed policy.

## API and Defaults

An optional `/groups` module provides `groupPolicy(store, { groups, maxAgeS?, nowMs? })`; the app supplies a group-to-scopes mapping. Freshness defaults to 15 minutes; run sync every 5 minutes. Missing/stale groups contribute no scopes, while other fresh groups can still contribute their independently configured scopes. Explicitly compose any break-glass admin policy outside this policy.

`/google-directory` adds `syncGroupSnapshots`, reusing the current token and pagination helpers. Fetch every configured group before writing any snapshots; a failed listing leaves prior snapshots unchanged, aging toward denial. A group with no members is a successful empty snapshot, not a failure. A store must reject an older result overwriting a newer snapshot. `/groups/d1` has an optional migration track.

## Operational Boundary

No credential provisioning, production migration or policy rollout is authorized by this implementation. Prefer a service account with a read-only Groups Reader role assigned by an OA Workspace administrator, not group ownership. Directory mode supports the existing nested-membership path. The broker/app placement remains a rollout decision: an app-local snapshot can revoke scopes on its next request; an OIDC claim consumed only at login cannot.

## Acceptance

- Independent overlapping memberships merge scopes, with case-folded identities.
- Missing, stale, future-dated and empty snapshots deny; the exact freshness boundary denies.
- Failed multi-group listing performs no writes; a newer snapshot survives an older sync completion.
- D1 SQL and existing Google sync tests pass; no production behavior changes.

## Implemented First Phase

`src/groups/index.ts`, `src/adapters/d1-groups.ts`, `migrations/groups/0001_snapshots.sql` and `syncGroupSnapshots` are implemented. The new sync defaults to Directory mode for role-assigned read-only credentials; the legacy `syncGroupsToAllowlist` keeps its existing Cloud Identity default. D1 refuses same-time as well as older writes, so an ambiguous concurrent completion cannot restore a removed member at the same epoch second. Tests exercise real SQLite, overlapping groups, expired/future/missing/empty snapshots, removal, failed listing with no writes, and expiry of an existing gate session.

Remaining rollout: choose where OA's directory credential and scheduled sync live, obtain the read-only Workspace grant, migrate the chosen database, and have consumers check membership per request. Central distribution/back-channel revocation is not implemented by this phase; there is no claim of fleet-wide instant revocation. No production credentials or policies have changed.
