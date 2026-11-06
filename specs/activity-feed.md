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
