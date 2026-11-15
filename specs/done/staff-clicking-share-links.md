# Staff clicking someone's share link, and a way out of a link session

Requested from `jobs` on 2026-11-15.

## The situation

Ryan drafts outreach emails in a Slack DM with colleagues (Jeff, Yael) before sending them. The draft contains the recipient's per-JD links (`jobs.oa.dev/eng-mgr-nyc?key=…` for Hilary Mason). When a colleague clicks one:

- their browser redeems Hilary's link and becomes "Hilary" (an `anon` session: no chip, so no visible way to sign out or switch to their OA account);
- their visits are attributed to Hilary in stats and in the Slack activity feed, and spend her redemptions;
- Ryan's workaround is the line "You can OA SSO into these auth-clearing links as well (if you already clicked Hilary's above)", but nothing actually clears the link session.

## Asks

1. **A signed-in staff session wins over `?key=`.** If the request already carries a valid SSO session for an allowed staff email, don't redeem: strip the key (same 302), keep the staff session, and log `event: 'staff-click'` (or `preview` with `reason: 'staff'`) against the grant, so the card can say "opened by staff: Jeff Hammerbacher" without counting it as the recipient. App option to turn this off for apps where staff legitimately test links as recipients (or a `?as=recipient` override).
2. **A clearing sentinel: `?key=-`.** Ryan's proposal. On any path: sign out the current link session (only a grant session; never an SSO one, see 1), log `signout`, then 302 to the same path without `key`, where the app's normal gate takes over (for `jobs`: the sign-in page, so staff land in OA SSO). Appendable to any URL, which is the point. It's a GET that signs out, so it's CSRF-able, but the worst case is a link recipient getting signed out of a link session they can re-enter with their link; acceptable. Keep the redemption-free, side-effect-light semantics: no redemption, no deny row.
   - Pick the exact token so it can never collide with a real key: real keys are 32 base64url chars, so `-` is safe. Export it as a constant (`CLEAR_KEY`) and accept only that exact value.
3. **Retained mode**: with several logins in one browser, `?key=-` removes only link logins and selects the SSO one if present.

## What `jobs` will do after this lands

Bump the dist; mention `?key=-` in the README; nothing else (staff-wins is server-side).

## Status: done

1. `gate.redeem` keeps a browser signed in by email as itself: no redemption, `access_log.event = 'staff-click'` (`session_sub` = the staff email), and `{ ok: false, reason: 'staff', email, response }` where `response` is a 302 to the same URL without the key. `staffKeepSession` (default true) turns it off; `?as=recipient` on the link bypasses it (and is stripped too). `GrantActivity.staffClicks` lists who, most first, and leaves them out of clients and countries; `GrantCard` shows "opened by staff". The activity bridge maps it to a `staff` kind, off unless declared. In retained mode this check is skipped: retained mode already holds the link as an account to switch to, spending nothing.
2. `?key=-` (`CLEAR_KEY`, exported from the server and client entry points): `redeem` returns `{ ok: false, reason: 'cleared', response, cookies }`. Single-session mode clears the cookie only if it's a link session, and logs `signout` with `reason: 'clear-key'`; an email session is untouched and nothing is logged. `authenticate` treats `?key=-` as no credential, so there's no deny row.
3. Retained mode: `retained.clearLinks` removes every link login from the browser, and if nothing is active then, selects its latest email sign-in.
- Added `gate.handleKeyParam(req)` for the whole `?key=` step (`keyParam` option, default `key`): `jobs` can replace its redeem block with `const keyed = await gate.handleKeyParam(req); if (keyed) return keyed`. Its current block falls through to `authenticate` on any non-ok result, so without that change the staff and `?key=-` redirects (and the preview card) aren't sent; a staff click still doesn't redeem.
- `/exchange` (client-side key exchange) answers `staff` and `cleared` with 200 `{ ok: true, staff | cleared: true }` and the clearing cookies.
