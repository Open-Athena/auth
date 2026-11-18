# "That was me": attribute share-link visits to staff

From `jobs` (2026-11-16, dist `4ae2079`). Builds on `view-dedupe-per-browser.md` (per-browser session ids); do that first.

## Problem

Staff test share links (incognito, a second browser), and those visits show up in grant stats and Slack as the recipient's. On 2026-11-16, Ryan's incognito test of Hilary's link posted as "Hilary Mason · share link · 2 page loads", and counted as her redemption and views on the grant card.

## Ask

### 1. Automatic: a per-browser id

- A long-lived, first-party, `HttpOnly` browser-id cookie (random, e.g. `bid`), set on any response that sets a session (SSO or grant). It is not the session id: it outlives sessions and sign-outs.
- Record it on `access_log` rows (new column) and session-log batches.
- A `bid` ever seen with a staff SSO session, before or after the share-link visit, marks that browser as that staff member's. Their share-link visits are attributed to them: `attributed_to` (email) on the row, or a `browser_owner` table joined at read time. Read-time join is better, since it also covers "subsequently logged in".
- Incognito and new profiles get a fresh `bid`, so those still need the manual path below. That's the common testing case, so the manual path matters most.

### 2. Manual: a Slack reaction on the activity post

No buttons on every post. A staff member reacts to an activity post (thread parent) with a configured emoji (default `:raising_hand:`, configurable per app) to say "that was me".

- Slack Events API endpoint (`reaction_added`, `reaction_removed`), verified with the signing secret. Scopes: `reactions:read`, plus `users:read` and `users:read.email` to map the reacting Slack user to an email.
- Look up which visit (burst) the message is for. The sink already stores message `ts` per burst for edits.
- Mark that burst's sessions (per-browser, from the dedup spec) as the reactor's, and the `bid`s too, so later visits from that browser auto-attribute.
- Edit the post (`chat.update`): relabel it, e.g. "Ryan Williams (testing Hilary Mason's link) · 2 page loads". Icon and username can't change on edit (Slack keeps the sender it was posted as), so the text carries it.
- `reaction_removed` undoes it.
- Only staff-domain reactors count; other reactions are ignored.

### 3. Manual: on the grant card

Per-visit rows on the grant card (or in the admin sessions view) get a "that was me" toggle, with the same effect as the reaction. Attributed visits are excluded from the card's redemption/view counts (or shown separately, "2 views, +2 by staff").

### 4. Slack icon for staff: prefer the Slack profile photo

Unrelated, but same scopes: Louisa Huang's posts in `#wip-jd-logs` show a blue notebook icon, while her Slack profile has a real photo. `jobs` uses the stored SSO profile photo (Google `picture`) as `icon_url`. For staff actors, the Slack photo (`users.lookupByEmail` → `profile.image_192`) matches what the channel expects. A helper in `activity/slack` (cached, with a fallback to the stored photo) would let `jobs`'s `actorSender` use it.

## Tests

- Two cookie jars: jar A signs in as staff, then redeems a link; its view is attributed. Jar B redeems the same link first, then signs in as staff; its earlier view becomes attributed.
- A signed `reaction_added` for a known post marks the burst and calls `chat.update` with the relabeled text; `reaction_removed` restores it. A bad signature is a 401; a non-staff reactor is ignored.
- Grant stats exclude attributed visits.

## What `jobs` will do after this lands

Bump the dist; add the Slack app's event subscription URL and scopes (Ryan, via the app manifest), and `SLACK_SIGNING_SECRET` as a Worker secret; switch `actorSender` to the Slack-photo helper.
