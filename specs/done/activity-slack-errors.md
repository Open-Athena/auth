# Activity Slack sink: say why Slack refused, and back off per-request retries

Requested from `jobs` on 2026-11-11, after adopting `@open-athena/auth/activity` (dist `2c9be8e`) with an `OA Jobs` bot.

**Status (2026-11-14): done.** All three parts are implemented; see "Implemented" at the end.

## 1. Include Slack's error code

`slackActivitySink.send` throws `activity: Slack rejected message` when `result.ok !== true`, dropping Slack's `result.error`. In `jobs` the bot wasn't in the channel yet, and logs only showed the generic message, so the cause (presumably `not_in_channel`) had to be guessed.

Include the error code, e.g. `activity: Slack rejected message (not_in_channel)`. Slack's `error` is a short fixed code and never echoes the token; still cap it (e.g. 64 chars, `[a-z_]` only) so nothing unexpected reaches logs. Same for the Discord sink if it has the equivalent.

## 2. Don't retry delivery on every request while a sink is failing

`jobs` calls `feed.drain()` in `waitUntil` after each request, plus `maintain()` on a minute cron. While Slack rejected every post, each page request (including `favicon.ico`, `whoami`, asset loads) re-attempted every pending burst, so one page load made several failing Slack calls. Consider a per-sink backoff (e.g. after a failure, skip that sink until `now + min(2^n × 30s, 15 min)`, stored with the delivery row), so request-path drains become cheap no-ops and the cron does the retrying.

## 3. (Optional) constructor errors

`slackActivitySink` throws `invalid Slack token` for an empty token. `jobs` hit that because `wrangler secret put` run non-interactively stored `""`, and since `jobs` built the sink per request, the throw took the whole site down (Error 1101) until it caught it (`jobs` `493b2fe`). Worth a README note for adopters: build sinks defensively, or validate config at deploy time rather than per request.

## Implemented

- **Error codes.** Slack's `error` is appended when it matches `^[a-z_]{1,64}$` (`activity: Slack rejected message (not_in_channel)`); anything else is left out. Discord failures append the JSON `code` when it is an integer (`activity: Discord HTTP 404 (10015)`). Tests: `test/activity-bridges.test.ts`, "says why a sink refused".
- **Backoff.** Per (burst, sink) delivery row, as suggested, not a separate per-sink table. New migration `migrations/activity/0002_post_failures.sql` adds `activity_posts.failures`. On a failed send, `activityFeed` calls the new `ActivityStore.defer(burstId, sink, token, retryAtS)`. That drops the lease, counts the failure, and sets `claim_until` to `now + min(30s × 2^(failures before), 15 min)`, so claims (and therefore `deliver`/`flush`) return `busy` until then. A success resets `failures` to 0. A new burst on a still-failing sink still costs one call before it starts waiting. `ActivityClaim` gains `failures`. Custom `ActivityStore` implementations need `defer`. Test: `test/activity.test.ts`, "backs a failing sink off per burst".
- **Constructor errors.** Documented in `docs/activity-adoption.md` (build sinks once, or validate config at deploy time), next to the backoff and migration notes.
