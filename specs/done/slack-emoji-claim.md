# A person's Slack emoji on their broker profile, passed to the apps signing in through it

*(Requested from disky's r2 session, `~/c/disky/wt/r2`, 2026-11-16.)*

## Why

disky's scan-health threads (and later, other OA bots' posts) mark who started a run. Ryan wants the person's own custom Slack emoji there (`:ryan:` exists in the OA Slack), not a generic 👤. A person's emoji is identity data, the same across every OA app and deployment, so it belongs on the broker's profile beside the name and photo, not in each app's tables.

## Requirements

- **A broker profile field, `slack_emoji`**: a Slack emoji name in the OA workspace, stored normalized as `:name:` (`^:[a-z0-9_+'-]{1,100}:$`). Null: none.
- **Any person, not a role.** It's on the profile, so it applies to everyone with one (or backfilled ahead of their first sign-in), admin or not. Grants (share links, service links) don't carry it. A grant's own emoji, e.g. an optional field at mint time, is deliberately left for later.
- **Not self-serve.** People don't set their own; the mapping is made once for everyone (the backfill below) and maintained by broker admins. The profile editor shows it read-only at most; `putProfile` from a person never writes it.
- **Passed to relying parties** with the `profile` claims (a custom claim, e.g. `oa_slack_emoji`; your call on the name and on whether it needs its own scope). Only the normalized name, never markup.
- **The RP keeps it current.** `seedProfileFromClaims` skips existing rows today. The emoji is broker-owned and an RP never edits it, so overwriting it on every sign-in is safe (unlike the name or photo). A changed or removed mapping should reach the RP's row at the person's next sign-in. If an RP row needs a column for it, that's a migration on the RP side; say what it is.
- **A lookup by email, for sessions that didn't come through the broker.** An RP whose user signed in with Google directly (or by emailed code) has no claim to read. The RP asks the broker server-to-server for an email's emoji, authenticated as its registered client (its client id + secret), and gets `{ slack_emoji }` or null. Answer only for people that client's `policy` / `allow` would admit, the same check `/oidc/picture` makes, so a client can't enumerate the directory. Rate-limit it per client, and never return anything but the normalized name. disky would call it once per "Run a scan" click, so the volume is tiny.
- **Backfill, once, for everyone.** Make the candidate mapping from the OA Slack itself: the workspace's custom emoji (`emoji.list`) matched to its members (`users.list`, emails via `users:read.email`), by an emoji named after a member's handle, display name or first name. Write the candidates to a reviewable file (email, Slack handle, proposed emoji, how it matched, plus the unmatched members and ambiguous emoji) for Ryan to approve before anything is written. Then apply the approved rows to the broker's profiles, for people with a profile row and for listed people who have yet to sign in, if the store allows a row ahead of sign-in. The Slack token needed for the read (`emoji:read`, `users:read`, `users:read.email`) is Ryan's to provide or create; don't create one.
- Re-running the backfill later (new hires, new emoji) should be the same command, proposing only changes.

## Downstream (disky; not for this repo)

Once the claim and lookup are live, disky's site sends the dispatching person's emoji (from their profile row, else the lookup by their address) when they click "Run a scan" (beside `DT_TRIGGER_BY`, their address). The scan job records it on the run, and the scan-health thread shows it in place of 👤. Runs without one, such as CLI runs, Google sign-ins or people with no mapping, keep 👤 plus the name. Tell disky's root session (`disky`) when this is deployed, with the claim's name and the RP-side column if any.

## Done (code; not yet deployed)

- **Profile field:**
  - `profiles.slack_emoji`, added by `migrations/0007_slack_emoji.sql`. It's the same table in the broker and in every app, so that's also the app-side column.
  - `Profile.slackEmoji` and `Subject.slackEmoji`.
  - `normalizeSlackEmoji` / `SLACK_EMOJI` (lower-case `:name:`).
  - The D1 profile read is `SELECT *`, so an app on the new dist without the migration still reads profiles. Only writes of the emoji need it.
- **Not self-serve:**
  - `ProfileStore.setSlackEmoji` (optional) and `gate.setSlackEmoji(email, emoji | null)` write it.
  - `put` never does, so `putProfile` can't.
  - With no row yet, it creates one ahead of sign-in: no name, `seed-pending` photo, `updatedAt` 0. The first sign-in then fills both the name and the photo. Before this, the seed only filled a pending row's photo; it now also fills the name of a row made ahead of sign-in (`updatedAt` 0, never self-edited).
- **Claim:** `oa_slack_emoji` (`SLACK_EMOJI_CLAIM`, exported from `/provider`), under the existing `profile` scope; it needs no scope of its own. It's always present under `profile` (`null` when none), so a removal propagates. It's reserved, so a `claims` hook can't set it, and it's listed in `claims_supported`.
- **App keeps it current:** `seedProfileFromClaims` copies it on every sign-in, when the claim is present. `null` clears it. Its absence (a Google sign-in) or a value that isn't an emoji name leaves the copy alone.
- **Lookup:** `POST /oidc/slack-emoji`, form `email`, with the client authenticated as at `/token` (Basic or `client_secret_post`). The answer is `{ slack_emoji }`.
  - It's `null` alike for no emoji and for someone the client's `policy` / `allow` wouldn't admit, so it can't enumerate the directory.
  - Limited per client per minute (`slackEmojiLookupsPerMinute`, default 30, `false` turns it off), counted per isolate.
  - The app's side is `lookupSlackEmoji(email, { issuer, clientId, clientSecret })` in `/oidc`.
- **Backfill:** `scripts/slack-emoji-backfill.mjs`.
  - `propose` reads `emoji.list`, `users.list` and the broker's current mappings, and writes `tmp/slack-emoji.tsv`.
  - The file holds changes only: an emoji named after a member's handle, display name, full name or first name, never one another member's names also spell. Unmatched members and ambiguous emoji follow as `#` lines.
  - `apply FILE [--dry-run]` writes the kept `set` / `clear` rows with the same upsert as the store.
  - The token comes from `$SLACK_TOKEN` and needs `emoji:read`, `users:read` and `users:read.email`.
- **Tests:**
  - `test/slack-emoji.test.ts`: normalizing; the store and gate, on memory and D1.
  - `test/provider.test.ts` ("the Slack emoji"): the claim through a real sign-in, changes and removal, the lookup, auth, the rate limit, and `lookupSlackEmoji`.
  - `test/slack-emoji-backfill.test.mjs`: matching, the review file, and the SQL.
- **Left to do:**
  - Apply `0007` to the broker (`db:remote`) and deploy it.
  - Ryan provides a Slack token and runs `propose`, reviews the file, then `apply`.
  - disky applies `0007` and takes the dist.

## After: apps look it up rather than keep a copy (2026-11-16)

Ryan: apps should ask `login.oa.dev` when they need an emoji, not each keep a copy of the mapping that goes stale.
- **Batch:** `POST /oidc/slack-emoji` takes `email` repeated, up to 100 (`MAX_LOOKUP_EMAILS`). It answers `slack_emojis` by lower-cased email, plus `slack_emoji` when one was asked. A request counts once against the rate limit, whatever its size.
- **`lookupSlackEmojis(emails, opts)`:** splits a long list into requests of 100. `lookupSlackEmoji` wraps it.
- **`slackEmojiClient(opts)`:** `get` / `getMany` / `forget`, with a memory cache (`ttlS`, default 600; nulls cached too). Concurrent asks share a request, and a failure isn't cached. Make one per isolate.
- **The claim and the app-side column stay, but optional:** a sign-in copies the emoji into the column, and it's only as fresh as that person's last sign-in.
- **Applied:** 34 mappings were written to the broker on 2026-11-16 (32 of them ahead of a first sign-in).
