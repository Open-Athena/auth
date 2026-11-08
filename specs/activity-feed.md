# Extract disky's activity feed: who did what, posted to an admin channel

*(Requested from `jobs.oa.dev`, `~/c/oa/jobs`, 2026-11-06.)*

## Context

The user wants what disky does in its `#*-admin` Slack channels across projects, starting with `jobs.oa.dev`: when someone we shared with shows up, staff hear about it, and can read what they looked at.

The session log is already in this package, and `jobs` now uses it. The feed on top of it is still disky-only (`~/c/disky`):

- `site/functions/_lib/activityShape.ts` (kinds, bursts, Slack and Discord rendering) and `activity.ts` (D1 and sink I/O)
- `site/functions/_lib/slack.ts`, `site/functions/api/activity/[[path]].ts`, `site/src/ActivityPage.tsx`, `site/src/ActivityKinds.tsx`
- Design: `specs/done/activity-feed.md`

`sessionLogRoutes` already has the seams (`onStored`, `filterEvents`, `onPurge`), and disky's kinds mix generic ones with its own (`assign`, `stage`, `deletion`, `digest`).

Disky also still seems to run its own session-log copy (`site/src/sessionLog.ts`, `functions/_lib/sessionLogShape.ts`) rather than this package's, despite `specs/done/ctbk-session-logging-extraction.md` naming it the first adopter. Please confirm with `gcs-1a`, because it affects how the two can merge.

## Requirements

- A new subpath (e.g. `@open-athena/auth/activity`, with `/d1` and a React admin piece), kept out of apps that don't import it, with its own migration track like the session log.
- The generic parts: bursts (one person, no gap over `BATCH_GAP_S`), per-kind record and notify settings (`off | count | line`), sinks that edit one thread or message in place as a burst grows, retention.
- **Kinds are the app's:** the package ships generic ones (`view`, `nav`, `click`, `error`, `access`) and the app declares its own. Disky-only behavior (staged-deletion threads, sizes, Slack actions) stays in disky.
- **Sinks are pluggable:** Slack and Discord ship, each optional. No sink configured means it records but posts nothing.
- A reasonable way to feed it from the access log as well as the session log, since `jobs` serves PDF and Markdown that no browser script sees.
- Actor naming for links with no address: name the recipient, not `grant:<id>`. The memo is private, so it can only go to staff-facing sinks, and sinks need to be treated as staff-facing.

## Related: `SessionLogWho` has no link identity

`fromGate` logs an unbound link as `{ email: null, via: 'grant' }`, so the viewer shows "anonymous" for exactly the people you share with. `jobs` overrides `identify` to put the name in `via`. A first-class field (grant id and subject name) would also let the sessions filter find them.

## Not in scope

Group-based access; that's a separate question for the user.

## Downstream

`jobs` becomes the first small adopter, and disky migrates when `gcs-1a` is ready. Tell the `jobs` session the dist SHA.

## Implementation Phases (2026-11-07)

The backend phase is implemented as optional `/activity`, `/activity/d1`, `/activity/slack` and `/activity/discord` entrypoints with `migrations/activity/`. It records replay-keyed events into actor-and-origin bursts, captures per-kind record/notify modes, exposes bounded retention and delivery leases, and supplies session/access-log bridges. Sinks edit one message per burst, not disky's app-specific staged-deletion threads. `record` does not send network requests; callers explicitly await `deliver`/`flush` or schedule them with their runtime's lifetime mechanism. No scheduler is provisioned.

Actor labels use recipient subject/address, never private memo. The sink contract requires an explicit staff-only acknowledgement, which is not proof of channel membership/privacy. Applications must enforce staff authorization around any reads or settings. A remote message create can succeed before its response is lost: retry may duplicate a message, and no exactly-once guarantee is claimed. Recording policies are captured at ingestion; changes are not retroactive.

Still pending after the backend phase: React admin surface and authorized read/settings routes, first-class persisted grant identity/filtering in `SessionLogWho`, reconciliation with disky's private session logger, jobs adoption and deployment. No dist SHA is available for these uncommitted changes. This spec remains active until those acceptance items are met.

Verification: 15 activity tests cover real SQLite grouping/transactions/replay/retention, concurrent delivery fencing and retry, recipient-vs-memo identity, session/access bridges and mocked Slack/Discord create/edit payloads. The SQLite shim serializes transaction boundaries to model D1; this is not a live Workers concurrency test. Slack's public block validator accepted the message layout; no real Slack or Discord messages were sent.
