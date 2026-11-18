# View dedup swallows other browsers on the same share link

From `jobs` (2026-11-16, dist `4ae2079`).

## What happened

1. At 13:00 ET Ryan opened Hilary's link (`/eng-mgr-nyc.pdf?k=…`, then `/eng-mgr-nyc`) in an incognito window. Both views posted to Slack.
2. Around 13:50 ET he opened `/eng-mgr-nyc?key=…` (same grant) in a different Chrome. Nothing posted.

The likely cause is `access_log_dedupe`, which is a partial unique index on `(event, session_sub, path, bucket)`. For a grant session `session_sub` is `g:<grantId>`, the same for every browser that redeems the link. So the second browser's `view /eng-mgr-nyc` in the same hour hit the index and was dropped. Its `redeem` row landed, but `jobs` notifies only views.

This was inferred from the code and the Slack posts; `jobs` hasn't read the production `access_log` to confirm it. Confirm it with a test.

The dedup is meant to stop a chatty single client from flooding the log. Here it also hides *a different person*: a recipient forwarding the link, or a colleague clicking it, within the hour of an earlier view of the same page.

## Ask

- Dedupe per browser session, not per grant. Options:
  - `session_sub` carries a per-redemption suffix for grant sessions (e.g. `g:<grantId>:<sid>`, the session cookie's own id). Keep `grant_id` as the grouping column.
  - Or add a `sid` column and use it in the index.

  Whichever is used, stats that group by grant should keep working. "Distinct clients" can then count sessions, not just `ip_hash`.
- SSO sessions should dedupe per browser session too, for consistency. An admin with two browsers isn't important, though.
- A test: two redemptions of one grant from two cookie jars, each viewing the same path in one hour, give two `view` rows (and two activity lines).

## Related, for a later spec (not this one)

Ryan wants visits marked "that was me". The plan is a long-lived per-browser id cookie recorded on access rows. A browser ever seen with a staff session, before or after, has its share-link visits attributed to that staff member, flagged in stats and relabeled in Slack. There would also be a manual "that was me" control: on the grant card per visit, and as a Slack button on activity posts via the interactivity endpoint. The session id above is a step toward it. `jobs` will spec it separately once Ryan confirms.

## What `jobs` will do after this lands

Bump the dist. If the dedupe key changes in a migration, `scripts/deploy.sh` applies it.

## Done (2026-11-18)

Confirmed by `test/view-dedupe.test.ts` before the fix: the second browser's view was dropped (one row, not two).

- A new `access_log.sid` column (migration `0008_access_log_sid.sql`, `NOT NULL DEFAULT ''`) holds which browser a row came from, and `access_log_dedupe` is now on `(event, session_sub, sid, path, bucket)`. That's the spec's second option; `session_sub` keeps its `g:<id>` / `e:<email>` meaning, so everything grouping by grant or by session is unchanged.
- `sid` is `c:` plus 16 characters of an HMAC (under the gate secret) of the cookie naming the browser's session. In retained mode that's the browser's handle cookie, which outlives logins; otherwise it's the session cookie. A redemption and a sign-in use the cookie their response sets, so they share the id of the views after them. A request with no such cookie (a presented `?key=` or Bearer token) gets `n:` plus a hash of its IP and user agent. Events logged without a request (mint, revoke, reveal) get `''`.
- SSO sessions dedupe per browser too, for free.
- Every `AccessEvent` from a request now carries `sid` (`AccessEvent.sid`), a step toward [that-was-me](../that-was-me.md).
- Not done: grant stats still count distinct clients by `ip_hash`. Counting sessions instead (`COUNT(DISTINCT sid)`) is a one-line change in `d1AuditQuery.activity` plus a new `AccessStats` field, left for when a consumer wants it.
- Two browsers that redeem one link in the same second get identical session cookies, so they share a `sid`. Rare enough to leave.
