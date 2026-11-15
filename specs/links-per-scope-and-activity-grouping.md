# Per-page share links, password-manager opt-out, session tags, and activity grouping knobs

Requested from `jobs` on 2026-11-15, after adopting dist `17d7dc9` (threads, `anon`). Items 1–2 are small and unblock Ryan minting links for people now; 3–4 are design plus build.

## 1. `GrantLink`: one link per page, not just one link

A link's key works on any path the app serves (`jobs` redeems `?key=` before routing), so one grant with several scopes can be sent as several URLs, one per page: `jobs.oa.dev/eng-mgr-nyc?key=T`, `jobs.oa.dev/dir-eng-sf?key=T`. Today `buildLink(grant, token) → string` shows one URL, and the token is shown only once, so the minter has to hand-edit paths.

- Let `buildLink` return `string | { label: string; url: string }[]`. For an array, `GrantLink` shows one row per entry (label, read-only URL, its own Copy), plus a "Copy all" that copies `label: url` lines.
- Same for the rotated-token view (`GrantCard` after Rotate).
- `jobs` will pass one entry per JD scope (label = JD title), plus the index page.

## 2. Password managers stay out of the mint and edit forms

1Password offers to fill the "Recipient's email" field in `GrantMintForm` (screenshot in the `jobs` session): `autoComplete="off"` doesn't stop it. Add `data-1p-ignore`, `data-lpignore="true"` and `data-bwignore` (1Password, LastPass, Bitwarden) to the recipient name, email and photo inputs, and to the holder edit fields in `GrantCard`. These are someone else's details, never the admin's own.

## 3. `anon` copy

`jobs` renders no chip at all for `anon` sessions, so its label will read "Anonymous: the recipient sees no name, photo or account menu" (via `labels.anon` / `labels.anonToggle`). Consider making that the default wording when the app uses `<WhoamiChip anon="hidden">`, or documenting that the label should match the chip mode.

## 4. Activity grouping: defining a "burst", and knobs

Today a burst is one actor's events with no gap longer than `BATCH_GAP_S`, and a tab's session rejoins its own burst for 7 days; one burst = one Slack thread. That's the standard approach: web analytics "sessionization" by inactivity timeout. Background:

- Catledge & Pitkow (1995), "Characterizing Browsing Strategies in the World-Wide Web": a 25.5-minute inactivity timeout (mean gap + 1.5 SD), the origin of the 30-minute default Google Analytics and most tools still use.
- Cooley, Mobasher & Srivastava (1999), "Data Preparation for Mining World Wide Web Browsing Patterns", and Spiliopoulou et al. (2003), "A Framework for the Evaluation of Session Reconstruction Heuristics in Web-Usage Analysis": time-based heuristics (total session length cap; per-page gap cap) versus navigation-based ones (referrer chains).
- Kleinberg (2002), "Bursty and Hierarchical Structure in Streams": "bursts" as a rate state machine, if we ever want rate-based rather than gap-based grouping.

Proposed, with the current behavior as defaults:

- **Grouping knobs** on `activityFeed`: `gapS` (inactivity timeout; document the 30-min convention), `maxSpanS` (start a new group after this long even without a gap, so a tab left open for days doesn't keep one thread forever), `resumeS` (how long a tab rejoins its own group; today 7 days), and `by: 'actor' | 'session'` (one thread per person across their tabs, or one per tab).
- **Session tags**: each session (tab `sessionId`; server-only events get the actor's latest) gets a short, stable visual tag at the start of its lines in thread replies: an emoji chosen by hash from a fixed set of distinct, easily told apart emoji, plus 2–3 hash characters to make collisions rare (`🦊a3`). Uniqueness only matters among sessions shown together in one thread. This lets several sessions' lines interleave in one thread and stay readable, and makes `by: 'actor'` the comfortable default.
- **Rendering nits** seen live in `#wip-jd-logs` (dist `17d7dc9`): times are UTC (`01:18Z`); show local time with the zone, or let the app pass a time zone / formatter. The details reply and the per-kind reply repeat each other for a burst with a single kind (`Pages: /rs`, then `• 01:18 view /rs on /rs`); fold them, and drop "on <page>" when the line is the page itself.

## What `jobs` will do after this lands

Pass per-JD `buildLink` entries; set the `anon` labels; pick grouping knobs (likely `by: 'actor'`, 30-min gap); bump the dist.

## Status

- §1–3 done: `buildLink` may return `{ label, url }[]` (`GrantLinks`), shown as a row per page with its own Copy plus "Copy all", at mint and after Rotate. `NO_AUTOFILL` (exported) is on the memo, recipient name, email and face inputs and the holder editor. `anonChip` (`'label' | 'pseudonym' | 'hidden'`, on `GrantsPanel`, `GrantMintForm`, `GrantCard`) picks the anon checkbox's default wording to match the app's `<WhoamiChip anon=…>`.
- §4: in progress.
