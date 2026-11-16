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
