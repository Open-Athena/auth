# Activity Feed Adoption

## Rollout Boundary

Jobs is the first intended adopter. Disky should reconcile its existing `auth-session-log-adoption` spec with this API before replacing private code. These instructions do not authorize deploying, enabling external notifications or moving raw private logs. Use the tested dist SHA supplied with the handoff, not an unverified working tree or branch head.

## Database and Identity

Apply `migrations/activity/0001_activity.sql`, then `0002_post_failures.sql` and `0003_threads.sql` (once each; they contain `ALTER TABLE`s) through an app-owned migration sequence. It adds independent activity tables and does not modify grants or session logs. If using the package's session log, also apply `migrations/session-log/0002_actor.sql` once after its `0001_session_log.sql`: it adds nullable `grant_id` and `subject_name` columns to existing `session_log`. Do not re-run ALTER statements or silently drop/recreate existing tables.

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

Add `slackActivitySink` or `discordActivitySink` only after confirming a staff-only destination. Supply a stable destination ID (change it when changing destinations), credential and `staffOnly: true`. This is an acknowledgement, not automatic channel-privacy verification. Record synchronously, then explicitly await `feed.flush()` or retain its promise with the platform's waitUntil. Use an app-owned cron/queue for durable retry. A failed send leaves that burst waiting before its next attempt to that sink (30s, doubling to 15 minutes, reset by a success), so a drain after every request costs no remote calls while a sink keeps refusing, and the cron picks the burst up once the wait is over. Errors carry the platform's short code, e.g. `activity: Slack rejected message (not_in_channel)` or `activity: Discord HTTP 404 (10015)`. Sink constructors throw on an empty token, channel or webhook (a non-interactive `wrangler secret put` can store `""`), so build sinks once at startup or validate config at deploy time, not inside the request handler, where that throw takes the whole site down. A send timeout after a remote create may duplicate a message; delivery leases do not make remote APIs exactly-once. Do not enable disky's old feed and this feed for the same events simultaneously.

### Slack threads

The Slack sink posts one thread per burst: a parent line (who, the notified counts, when, a link), a details reply (the pages visited, in order, and the burst's sessions), and one reply per notify=`line` kind (errors, access events, resumptions). Each is edited in place as the burst grows; each reply's message ID is saved as soon as it's posted, so a failure partway through never posts the parent twice. A tab's session (`sessionId`) rejoins its own earlier burst for up to 7 days (`RESUME_S`), adding a `resume` line ("after 2h 00m"), so one tab keeps one thread. Text is Slack mrkdwn with `<`, `>` and `&` escaped, so nothing a visitor types can form a link or a mention.

Hooks, all optional, on `slackActivitySink` (and the link ones on `discordActivitySink`):

- `actorSender(actor, burst) → { username, iconUrl? } | null`: post as the actor, with a name and an https face from your own trusted data (a grant's subject, a profile). It needs the bot's `chat:write.customize` scope; add it to the app manifest's `oauth_config.scopes.bot` and reinstall the app. Without it, or when the hook returns null, posts come from the bot with the actor named in the text.
- `eventHref(line, burst)`, `sessionHref(sessionId, burst)`, `burstHref(burst)`: links for page lines, a burst's sessions (and each line's time), and the burst in your own admin UI.
- `renderBurst({ burst, asActor, links }) → { text }`: replace the parent line (escape what you include, e.g. with `SLACK_FMT.esc`).

Discord stays one message per burst (webhooks have no threads to edit into), rendered the same way and cut to 2000 characters.

### Service links

`activityActorFromAuth` gives a service link (`grant.service`) `via: 'service'`. Such an actor's routine bursts post nothing (`deliver` reports `quiet`, and the burst is not left pending). A notable burst posts red, leading with why (`🔴 3 errors`); the next clean burst after a red posts green (`🟢 clean again`), then it's quiet again. The state is per actor, origin and sink. By default (`serviceReasons`), notable means at least `errorThreshold` (3) errors, any refused request, or a client the service hasn't used before (once it has an earlier burst). Pass `activityFeed({ service: { notable: (burst, { newClients }) => reasons } })` to decide yourself.

`accessLogActivity` records `deny` rows as the `denied` kind (a default kind, `line`/`line`), with the reason as the line (`revoked /scan`), and gives every row a client fingerprint (a hash of its IP hash and user agent). For session-log batches, pass `sessionLogActivity(feed, { client })` with your own fingerprint (hash the IP with a secret); never a raw address.

`feed.purge(cutoffS)` is bounded and uses receipt time; repeat while it deletes rows. Activity purge does not delete already-posted Slack/Discord messages. Source-row storage, bridging and remote posting are separate transactions: hook failure needs replay, not an assumption that everything rolled back.

## Verify Before Enabling

- A stranger/ordinary recipient gets 401/403 from list, detail and kind settings; cross-origin settings writes fail.
- A named unbound link appears by its recipient, is filterable, and never exposes the memo; old rows remain honest about missing identity.
- A repeated stored row/batch does not increment activity twice; app events retain only the configured detail.
- A PDF view reaches the feed without JavaScript; browser page loads do not double-count it.
- With sinks off, nothing is posted. With a staff test destination, the message is edited as a burst grows, retries remain pending and retention is bounded.
- Existing session timelines, switch audit, app events and staged-deletion flows still work. Do not treat the library browser mocks as this deployment's end-to-end evidence.

The demo has a staff-only `/admin/activity` route. Its source feed is record-only and gated by `ACTIVITY_ENABLED=1` after applying activity migrations; it does not post external messages. No production migrations or flag changes were made as part of implementation.
