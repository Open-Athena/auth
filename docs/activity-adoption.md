# Activity Feed Adoption

## Rollout Boundary

Jobs is the first intended adopter. Disky should reconcile its existing `auth-session-log-adoption` spec with this API before replacing private code. These instructions do not authorize deploying, enabling external notifications or moving raw private logs. Use the tested dist SHA supplied with the handoff, not an unverified working tree or branch head.

## Database and Identity

Apply `migrations/activity/0001_activity.sql` through an app-owned migration sequence. It adds independent activity tables and does not modify grants or session logs. If using the package's session log, also apply `migrations/session-log/0002_actor.sql` once after its `0001_session_log.sql`: it adds nullable `grant_id` and `subject_name` columns to existing `session_log`. Do not re-run ALTER statements or silently drop/recreate existing tables.

Existing logs remain in their own deployment database. There is no backfill claiming to know who old unbound links belonged to. New batches from `fromGate` carry server-trusted grant ID and recipient name; the session summary uses the latest batch's identity. Filters match address, subject name and grant ID. A private grant memo is not a recipient identity. Remove app workarounds that put a memo/name into `via` only after checking the new fields on real data.

## Minimal Wiring

```ts
import { activityFeed, activityRoutes, sessionLogActivity } from '@open-athena/auth/activity'
import { d1ActivityStore } from '@open-athena/auth/activity/d1'
import { fromGate, sessionLogRoutes } from '@open-athena/auth/session-log'
import { d1SessionLogStore } from '@open-athena/auth/session-log/d1'

const store = d1ActivityStore(env.DB)
const feed = activityFeed({ store }) // no external sink by default
const identity = fromGate(gate)
const hooks = sessionLogActivity(feed, {
  actor: ({ who }) => who.grantId
    ? { id: `grant:${who.grantId}`, name: who.subjectName ?? who.email ?? 'Unnamed recipient', via: 'grant' }
    : who.email ? { id: `email:${who.email}`, name: who.email, via: who.via } : null,
})
const sessions = sessionLogRoutes({
  store: d1SessionLogStore(env.DB), ...identity,
  onStored: hooks.onStored, onPurge: hooks.onPurge,
})
const activity = activityRoutes({ feed, store, requireAdmin: identity.requireAdmin })
```

Keep existing `appEvents`, `filterEvents` and `onSwitch` behavior when merging hooks; do not replace disky's `admin_edits` audit with a feed notification. Map app-specific events explicitly with `sessionLogActivity`'s `event` callback and declare their kinds in `activityFeed({ kinds })`. Staged-deletion threads, assignments, Slack actions and existing per-app write capture stay app-owned.

The staff React page imports `ActivityAdmin` from `/react/activity` and `/react/activity.css`, inside the app's QueryClientProvider and authenticated staff-page boundary. Unmount it on logout/identity change and clear or partition private query caches; the generic viewer does not discover the host app's identity endpoint. Its default API path is `/api/activity`; pass `endpoint` when mounted elsewhere. The server must enforce staff access even if the page/link is hidden. Use a stronger staff scope than a publicly obtainable sandbox admin identity.

## Non-browser Access and Posting

For PDFs/Markdown/API views, replay accepted access-log rows through `accessLogActivity(feed, { origin, actor })`, supplying each row's stable database ID and resolving actors from trusted server data. This is not a generic AuditSink wrapper: that sink has no inserted-row ID or dedupe outcome. Process persisted rows with an application-owned checkpoint/retry job if durable capture is required. Avoid counting the same page through both access and session views unintentionally.

Add `slackActivitySink` or `discordActivitySink` only after confirming a staff-only destination. Supply a stable destination ID (change it when changing destinations), credential and `staffOnly: true`. This is an acknowledgement, not automatic channel-privacy verification. Record synchronously, then explicitly await `feed.flush()` or retain its promise with the platform's waitUntil. Use an app-owned cron/queue for durable retry. A send timeout after a remote create may duplicate a message; delivery leases do not make remote APIs exactly-once. Do not enable disky's old feed and this feed for the same events simultaneously.

`feed.purge(cutoffS)` is bounded and uses receipt time; repeat while it deletes rows. Activity purge does not delete already-posted Slack/Discord messages. Source-row storage, bridging and remote posting are separate transactions: hook failure needs replay, not an assumption that everything rolled back.

## Verify Before Enabling

- A stranger/ordinary recipient gets 401/403 from list, detail and kind settings; cross-origin settings writes fail.
- A named unbound link appears by its recipient, is filterable, and never exposes the memo; old rows remain honest about missing identity.
- A repeated stored row/batch does not increment activity twice; app events retain only the configured detail.
- A PDF view reaches the feed without JavaScript; browser page loads do not double-count it.
- With sinks off, nothing is posted. With a staff test destination, the message is edited as a burst grows, retries remain pending and retention is bounded.
- Existing session timelines, switch audit, app events and staged-deletion flows still work. Do not treat the library browser mocks as this deployment's end-to-end evidence.

The demo has a staff-only `/admin/activity` route. Its source feed is record-only and gated by `ACTIVITY_ENABLED=1` after applying activity migrations; it does not post external messages. No production migrations or flag changes were made as part of implementation.
