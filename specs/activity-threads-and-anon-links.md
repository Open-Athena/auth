# Activity Slack threads (disky's model), anonymous links, and the memo guarantee

Requested from `jobs` on 2026-11-14. Approved by Ryan in the `jobs` session (design below is what he agreed to there).

**Status (2026-11-14):** §2 and §3 are implemented; §1 (threads) is next.

§2 as built: `grants.anon` (with `service`, `migrations/0005_grant_flags.sql`). `holderIdentity(grant)` is the one filter: `whoami`, `/exchange`, and retained `/accounts` (logins and incoming offers) carry `subject: null, email: null, anon: true`, and account entries add `pseudonym`. `/profile` treats an anon link as having no principal, so the holder can neither read nor edit the profile of the email staff bound it to. `pseudonym(grantId)`: FNV-1a over the id into 64 adjectives × 64 animals ("Kind Marmot"). `displayName` returns null for anon. `<WhoamiChip anon="label" | "pseudonym" | "hidden">` (default `label`, i.e. `anonymousLabel`); `<AccountSwitcher>` shows the pseudonym. Admin: mint and card checkboxes ("Anonymous: the recipient doesn't see this name or photo") and an `anon` tag whose tooltip is the pseudonym. Staff routes, session-log identity and activity actors still use the real subject.

§3 as built: kept the field name `name` (renaming would break disky and `jobs` for no behavioral gain). Types and README call it a private note never shown to the recipient, and the mint form's placeholder says so. `test/holder-privacy.test.ts` mints an anon, email-bound link with sentinel memo, name, email and stored photo, then hits exchange, whoami (cookie and Bearer), profile GET/PUT, track, the grant admin routes, the access log, session-log ingest/list/detail, the activity routes and logout as the holder, and asserts no sentinel appears in any body or header. It fails without the profile fix above.

`jobs` uses `@open-athena/auth/activity` (dist `9c8be0d`) with the `OA Jobs` Slack bot in `#wip-jd-logs`. Its posts are one flat plain-text message per burst (`ryan.williams@openathena.ai (sso) <ISO> - <ISO> view: 3 [view] view /pm …`): no threads, no links, posted as the bot. disky's channels (`#gcs-admin` etc.) are much better, but disky has its own implementation (`~/c/disky/site/functions/_lib/activity.ts`, not this package). This spec moves disky's model into the package so `jobs` (now) and disky (later) share it, and adds anonymous links.

## 1. Threads: port disky's burst/thread model

Read disky's `site/functions/_lib/activity.ts` (`burstFor`, `bump`, `feedClient`, `recordServer`, `render`, `ensurePost`, `senderOf`/`slackSenderOf`) and its tests first. The behavior to adopt:

- **One Slack thread per burst.** A burst is one actor's activity until a quiet gap (`BATCH_GAP_S`). A tab's session-log `sid` resumes its own earlier burst for up to `RESUME_S` (7 days), so one tab keeps one thread; a resumed burst records a "resumed after <gap>" line. Server-only events with no `sid` (PDF/Markdown fetches, `jobs`' access-log views) join the actor's latest burst within the gap.
- **Thread layout:** a parent message re-rendered as the burst grows (who, when, counts, pages); a details reply; one reply per notify kind, edited in place as it grows (`ensurePost` per (burst, sink, slot)).
- **Sender:** posts as the actor (`username` + `icon_url`), falling back to the bot. Needs `chat:write.customize`; document it in the sink's README and the manifest example.
- **Formatting:** Slack mrkdwn with escaping, links where the app supplies URLs (page href, session-viewer href). Keep the existing per-burst length bounds and the "omitted lines" accounting.
- **Discord** keeps working (it can stay one message per burst if threads don't map cleanly; say which in the README).

Where disky's logic is disky-specific (staged deletions, OG cards, its identity registry), leave it out. The package needs hooks instead:

- `actorSender(actor) → { username, iconUrl? } | null`: who to post as. Apps resolve names and photos from their own trusted sources (for `jobs`, the grant's subject, see §2).
- `eventHref(event) → string | null` and `sessionHref(sid) → string | null`: links for page lines and for the burst's sessions (e.g. `jobs`' `/admin/sessions?sid=…`).
- Optionally `renderBurst(view) → { text, blocks }` to override the whole parent message.

Migration: whatever new columns or tables the threads need (`sids` on bursts, per-slot post ids), as a new `migrations/activity/000N_*.sql`; existing single-message posts can stay as they are.

Also fix: today's sink sends `\n`-separated `plain_text`, and the Slack client showed each burst on one line (screenshot in the `jobs` session). mrkdwn with explicit line breaks should fix that; check it renders line by line.

## 2. Anonymous links (`anon`)

A per-link flag, set at mint (and editable by staff): the recipient must not see who OA thinks they are.

- **Data model:** `anon: boolean` on the grant (default false). The link's `subject` (name, email, photo) stays as entered and is used server-side for staff views and activity senders.
- **Holder-facing output:** for `anon` links, `whoami` (and every other response the holder can reach) omits `subject` and the grant `email`, and includes `anon: true`. The holder's own pages must not be able to learn the staff-side identity.
- **`pseudonym(grantId) → string`:** a stable, deterministic "Anonymous Capybara"-style name from the grant id, so a link and all its sessions keep one name without storing it. Exported for apps and for staff UIs that want to show it alongside the real name.
- **UI components:** the chip / account components get a way to render nothing, or the pseudonym, for `anon` sessions. The app decides which; the package only provides the modes. `displayName()` should return null (not the subject) for `anon` whoamis.
- **Admin:** the mint/edit forms (React `ShareLinks` etc.) get an "Anonymous: the recipient doesn't see this name or photo" checkbox. Staff listings show the real subject plus an "anon" marker.

## 3. The memo is never shown to the recipient: say so and test it

A read in `jobs` found no leak (whoami deliberately omits `grant.name`; session-log and activity bridges skip it; the allowlist note that includes it is admin-only). Make it explicit:

- Types, README and admin labels call the memo a "private note (never shown to the recipient)". Consider renaming the field in the public API (e.g. `note`), with the old name kept as an alias only if BC matters to current adopters.
- A test that mints a link with a sentinel memo and (with `anon`) a sentinel subject name, email and photo, then requests every holder-reachable endpoint (redeem, whoami, profile, session-log ingest responses, activity routes as a non-staff holder, any React/Vue data loaders the package ships) and asserts neither sentinel appears in any body or header. An absence check is the right tool here: the property is "this string appears nowhere".

## Out of scope / for later

- A per-sign-in session id in `access_log`. disky's burst-plus-`sid` model makes it unnecessary for threading; revisit if apps need exact sign-in boundaries.
- Folding several short sessions into one thread beyond what the burst gap already does.

## What `jobs` will do after this lands

Bump the dist, apply the migrations, add the bot's `chat:write.customize` scope (Ryan reinstalls the app), supply `actorSender` (grant subject name/photo; SSO users' profile), `eventHref` (JD title → page), `sessionHref` (`/admin/sessions`), add the "Anonymous" box to its mint form, and render no chip for `anon` sessions.
