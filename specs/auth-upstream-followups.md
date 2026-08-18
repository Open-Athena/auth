# Follow-ups from watchy's adoption

Written from watchy (the first consumer) after a live end-to-end pass on `gh.oa.dev` against dist `f754988`. Two items found there are already fixed at HEAD (`94c8451`: `mint` logging, revoked grants no longer hidden) and are not repeated. What follows is one confirmed bug, and a set of features the adoption surfaced — ordered by how much they cost the consumer today.

## 1. `useForgetWhoami` doesn't re-render — sign-out silently no-ops (bug)

`useForgetWhoami` calls `client.removeQueries({ queryKey: WHOAMI_KEY })`. In query-core 5.101, `removeQueries` → `queryCache.remove(query)` → `query.destroy()` + delete from the map + `notify({type:'removed'})`. That notification goes to **cache**-level subscribers; a `QueryObserver` subscribes to the *query*, so no mounted component is told anything. The observer keeps rendering its last result.

Observed on watchy: clicking "Sign out" on the admin page cleared the cookie server-side (`set-cookie: …; Max-Age=0`, and the next navigation to a gated route 401'd) while the admin page carried on rendering the signed-out identity, table of grants and all. The user reported it as *"Sign out link is nop'ing"* — the worst shape of this bug, since it looks like a security failure even though the session is genuinely dead.

**Fix:** `resetQueries({ queryKey: WHOAMI_KEY })` — reverts to initial state *and* refetches active observers. Or set the data to `null` and invalidate. `removeQueries` is only correct for queries nobody is watching.

Worth a test, since the failure is invisible to unit tests that only assert on the query cache: mount a component using `useWhoami`, sign out, assert the component re-renders with the wall.

watchy currently works around it with `onSignedOut={() => location.reload()}`, which it may keep regardless: a reload also evicts every already-fetched private response from memory, which is arguably what sign-out should mean.

## 2. Identity responses carry no `cache-control`

`/whoami` (and the admin JSON) set no `cache-control`. Nothing is caching them today — Cloudflare returns `cf-cache-status: DYNAMIC`, and a validator-less 200 is unlikely to be heuristically cached — so this is hardening, not a live bug. But an identity endpoint that a proxy could serve to the wrong person is a bad thing to leave to chance, and the fix is one header: `cache-control: no-store` on every authenticated response.

## 3. E2E tests for the link lifecycle

The semantics I verified by hand are exactly the ones worth pinning in CI, because each is a *security* property that unit tests of the primitives don't cover end-to-end (real routes, real store, real cookie round-trip):

| Property | Assertion |
|---|---|
| redeem mints a session | `POST /exchange` → 200 + `Set-Cookie` with `HttpOnly; Secure; SameSite=Lax` |
| a grant is not an admin | grant cookie → gated route 200, **admin route 403** |
| revoke is immediate | revoke, then the same cookie → 401 on the next request, no cache window |
| counters | `redeems` increments once per *redeem*, not per request; `last_used_at` touched ≤ 1×/min |
| max-uses | `maxRedeems` exhausted → redeem refused, status `exhausted` |
| expiry | past `expiresAt` → redeem refused, and an already-minted session stops verifying |
| audit completeness | the above leaves `redeem` / `revoke` / `deny(reason=revoked)` rows carrying `grant_id` + `session_sub` |
| bad token | unknown/garbage token → `{error:'invalid link', reason:'bad-token'}`, and a `deny` row that is **not** deduped |

The `/testing` in-memory stores make most of this cheap; the cookie round-trip wants a real fetch handler (Miniflare/`unstable_dev`, or just calling `authRoutes` with hand-built `Request`s and threading the `set-cookie` back).

Suggested split: one e2e test per row above, plus one "happy path" narrative test that reads like the table — mint → redeem → use → revoke → denied.

## 4. Notification sinks, and acting *from* the notification

`Notify`/`NotifyEvent` already exist; what's missing is (a) concrete sinks and (b) the inbound half — approving without opening the admin page. The consumer-side cost today is that every app writes both.

**Correcting an assumption from the watchy side:** this needs no dedicated bot or separate function. The worker that already owns the auth D1 can host the interaction endpoint; what's needed is credentials and a signature check, not new infrastructure.

- **Slack.** `slackNotify({ token, channel })` posting a Block Kit message for `access-requested` with Approve/Deny buttons, plus `slackInteractions(gate, { signingSecret })` mountable on the same worker: verify `X-Slack-Signature` (HMAC-SHA256 over `v0:{ts}:{body}`, reject `ts` skew > 5 min), approve/deny, then `chat.update` the original message so the buttons can't be pressed twice and the audit trail shows who clicked. Requires a bot token with `chat:write` and the signing secret. Note the approver's Slack identity must map to an admin — the button is otherwise an unauthenticated grant endpoint for anyone in the channel.
- **Email in.** Cloudflare Email Routing can deliver to an Email Worker, so `access@…` → parse `From:` → create a pending request. Cheapest possible "request access" front door: no form, no page, and the address is shareable in prose.
- **Email out.** Approval mail carries the token, so it can't be skipped for the magic-link flow. Needs an ESP (Resend/Postmark) — MailChannels' free Workers integration ended in 2024, so this is a real dependency, not a footnote. Ship it as an adapter, not a hard dep.
- **Pushover.** Verified against the current API docs: there are **no custom action buttons**. Two usable mechanisms: `url`/`url_title` (a supplementary link under the notification), and emergency priority (`priority=2` + `retry`/`expire`), which shows an *Acknowledge* button and will POST to a `callback` URL when acknowledged. So "approve from the lock screen" is either a signed link, or ack-as-approve — and ack-as-approve is a bad fit, since acknowledging is also how you stop the retries, making "make it stop" and "grant access" the same gesture. Recommend the signed link.
- **Signed one-click approve links** (usable from email, Pushover, anywhere): a short-TTL single-use HMAC'd URL. Must land on a confirm page that POSTs rather than acting on the GET — mail scanners and link prefetchers *will* fetch it, and a GET that grants access will eventually be fired by a spam filter.

## 5. Richer requester profile than an email

watchy's ask: optionally collect first/last name and an avatar at request time, not just an email — a table of `bob@…` is worse than a table of people, and the avatar makes the "logged in as X" chip legible.

Suggest optional columns on `access_requests` + matching optional fields in `RequestAccessForm`, with the field list configurable so an app can ask for none of it. Avatar upload is a bigger commitment (storage, moderation, size limits); Gravatar-by-email-hash or initials-in-a-circle covers most of the value at none of the cost.

## 6. Upgrade a link session into a real identity

Today a link session is terminal: you are "whoever holds this link" until it expires. The natural upsell, once someone is already looking at the data: *"You're viewing via a shared link — verify your email to keep access"*, which turns an anonymous grant into an email-bound identity, surviving revocation of the shared link and making the audit log name a person instead of a link.

Mechanically it's the existing request flow with the grant session as evidence: prefill from the grant's `email` if it has one, mail a verification token, and on redemption issue an `e:`-subject session and mark the grant redeemed-by. The interesting policy question is whether that self-serve upgrade needs admin approval — probably yes by default, since otherwise forwarding a link silently manufactures new permanent identities.

## 7. Listing active sessions

watchy's ask: "list all active sessions, including SSO'd users."

**This is not currently answerable, by design.** Sessions are stateless signed cookies — nothing is written server-side at sign-in, so there's no set to enumerate. Three options, in increasing cost:

1. **Derive it from the access log** (cheap, no schema change): "identities seen in the last N minutes", grouped by `session_sub`. This is what an operator usually means by "who's on the site", and the data is already there. It cannot see an idle-but-valid session, and shouldn't claim to.
2. **A `not-before` epoch per subject** (small): one column, checked at authenticate; bumping it invalidates every existing session for that subject. This is "sign out everywhere", which is the action people actually want after listing sessions.
3. **A real session registry** (largest): put a session id in the claims and write a row per sign-in — enables per-device listing and per-device revoke, at the cost of a DB read on every authenticated request, which is exactly the property the stateless design was chosen to avoid.

Recommendation: 1 + 2. Skip 3 unless per-device revoke turns out to be a real requirement — the sign-in-from-a-hotel-laptop case is served fine by "sign out everywhere".

## Not blocking, noted

- The admin page's revoked-row rendering only worked once watchy passed `?all=1`; HEAD's default change fixes that for the next adopter.
- watchy deliberately does not use `ssoHandler`: it takes a whole gate (hence a D1 binding), and watchy's Pages project has none — its auth authority is a cross-account worker. A gate-less variant taking just `{ secret, teamDomain, aud, cookieName }` would let that project drop its last hand-written handler.
