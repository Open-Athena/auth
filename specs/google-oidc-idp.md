# Drop CF Access as IdP: `google-oidc` adapter (+ email-code fallback)

*(Requested by marin-gcs-usage, 2026-08-21 — consumer #2, Tier-2 live: D1 grants + share links + an app-owned `allowed_emails` allowlist checked in the email policy per request. CF Access is already reduced to a pure IdP on `/auth/sso` with an Everyone policy.)*

## Status (2026-09-19)

- **Ask 1 — shipped** (`src/adapters/oidc.ts`, commit `68bab91`), under generic names rather than `googleAuthUrl`/`googleCallback`: `oidcStart(opts)` and `oidcCallback(opts)`, both taking `OidcOptions { gate, clientId, clientSecret, redirectUri, provider? = GOOGLE, authParams?, … }`. `GOOGLE` is a preset `OidcProvider`; `hd` rides in via `authParams`. State is HMAC'd with the gate secret (`oidc:` prefix, mutually inert with `e:`/`g:` session subjects) and the nonce is double-submitted (signed state + short-lived cookie), exactly as the spec asked. `email_verified` is required. Covered by `test/oidc.test.ts`. So the two-Function consumer shape (`/auth/google` + `/auth/google/callback`) is available today — `oidcStart`/`oidcCallback` are the handlers.
- **Ask 2 — not built** (email codes for the non-Google tail). Decision pending (see Decisions).
- **Ask 3 — not built** (Google-first `react/` sign-in panel). Decision pending.
- **Ask 4 — not built** (Google One Tap / FedCM; added 2026-09-19). Decision pending.

## Why

- **The IdP hop is now the worst part of the flow.** A visitor hits the app wall → `/auth/sso` → CF Access's hosted page (org-branded, but generic copy, two auth options that have already confused users — "use the email login, not the Google login") → Google or OTP → back through the app. The app's allowlist refusal happens *after* they authenticate, as a 403. With our own login UI we can go **email-first**: enter address → allowed+Google-account → straight to Google; allowed+non-Google → send a code; not allowed → request-access form, before any auth happens.
- **Zero Trust seats.** Every Access-authenticated user consumes a ZT seat; the OA account is at **36 of the free tier's 50** (2026-08-21), and marin's allowlist alone is 52 non-OA emails. Share links avoid Access entirely (that's why they don't burn seats), but every SSO/OTP user does. Dropping Access as IdP removes the ceiling.
- README already names this direction: "peers of `adapters/cf-access` are Google/GitHub OIDC, WorkOS, or no IdP at all… those stay the only two adapters until a non-CF consumer appears." The consumer has appeared — it's on CF, but it wants off CF *Access*.

## Ask 1 — `src/adapters/google-oidc.ts`

Authorization-code flow (server-side, Pages Function-friendly):

- `googleAuthUrl({ clientId, redirectUri, state, hd? })` — build the consent URL (scopes `openid email profile`; `hd` optional domain hint).
- `googleCallback({ gate, clientId, clientSecret, redirectUri })` — exchange code, verify the `id_token` against Google JWKS (same JWKS-verify shape as `verifyAccessJwt`), require `email_verified`, then `gate.signIn(email, req)` → session cookie → redirect to `?next`. State should be HMAC'd with the gate secret (no extra storage).
- Non-goals: refresh tokens, offline access, profile storage beyond what `signIn` already does.

Consumer usage (mgu): two Functions, `/auth/google` + `/auth/google/callback`, a fresh OAuth client in `oa-internal-450019` (the existing `cloudflare-access` client keeps serving the CW host's Access app; consent screen is already External/In production, and basic scopes need no verification). Then the gcs Access app is deleted outright.

## Ask 2 (phase 2, or explicitly punt) — email codes for non-Google addresses

The tail that can't Google-auth (yahoo, custom domains — ~4 of marin's 52).

Honesty note: the package never sends email, so sans CFA there is **no automated email verification** — CFA's OTP is currently doing that job for free. The interim story is admin-mediated: mint an **email-bound grant** and send the link *to that inbox* (delivery-as-verification — possession of a link sent to the claimed address proves mailbox control, same trust as an OTP with one manual hop). That bridges a ~4-address tail but is not self-serve, so:

1. **Interim**: email-bound grants + request-access, with the admin delivering the link by email. Document as such — including "send it to the inbox, not a DM" (a DM'd link verifies nothing).
2. **Required eventually if CFA is fully dropped**: `core/email-codes.ts` — a pending-auth flow whose email carries **both a magic link and a short code** (the Slack pattern): the link is the happy path; the code rescues the cross-device case (started on laptop, email is on phone — type the code into the original tab instead of forfeiting that session) and survives link-prefetching security scanners that can consume single-use URLs. One pending-auth row backs both (id + hashed link token + hashed 6-digit code, single-use, short TTL); the original tab polls (or accepts the code) and mints the session in place. Pluggable `sendEmail` interface (Resend/SES/CF Email Service adapters). Real work: deliverability (SPF/DKIM for the sending domain), abuse throttling.

## Ask 3 — sign-in panel: Google-first, email-entry secondary

`react/`: the primary affordance is a single **"Continue with Google"** button — an immediate redirect, no typing; Google's account picker handles identity, and the app checks its allowlist when the id_token comes back. Not-allowed users land on a request-access form **pre-filled with their Google-verified email** (approval is then trustworthy — the address was verified by Google, not typed). The secondary affordance is "or enter your email", for the non-Google tail (code, once Ask 2 exists; request-access meanwhile). The email probe must not leak allowlist membership to anonymous callers (constant response shape).

## Ask 4 (optional, layers on 1+3) — Google One Tap / FedCM

The redirect button in Ask 3 is the auth-code flow: a full-page bounce to Google and back. **One Tap** (Google Identity Services, `google.accounts.id`) is the optimized variant — Google surfaces a prompt (or a rendered "Sign in with Google" button) *in the page*, the user picks an account without leaving, and Google hands back a signed **id_token** to a JS callback. No redirect, no second page. On modern browsers it runs over **FedCM**, the browser API that replaces the third-party-cookie mechanism One Tap used to depend on (Chrome's 3p-cookie deprecation breaks the legacy path, so FedCM is not optional going forward).

This is strictly additive — it reuses everything Ask 1 already built and never replaces the redirect flow (which stays the fallback when One Tap/FedCM is unavailable, dismissed, or on unsupported browsers).

**Backend — one new route, mostly a reuse of Ask 1's verify.** One Tap posts the credential to us; we verify it exactly like the callback already does:

- `googleOneTapVerify({ gate, clientId, allowedNonce })` — a handler for `POST /auth/google/onetap` whose body carries `{ credential, nonce }` (the credential is a Google id_token). Verify against Google JWKS (the same `verifyRs256Jwt` path `oidcCallback` uses), require `email_verified`, check `aud === clientId`, and check the **nonce** — One Tap nonces are double-hashed by Google (the id_token carries `SHA256(nonce)`), so we HMAC-sign the nonce we handed the page (no storage, same trick as the redirect state) and compare `sha256(nonce)` to the token's claim. Then `gate.signIn(email, req)` → session cookie → `200` (the page is already where it wants to be; no redirect needed). `g_csrf_token` double-submit if using Google's button-POST mode.
- No new verification infrastructure — this is `oidcCallback`'s second half (verify id_token → signIn) exposed as a credential-in rather than code-in endpoint.

**Frontend — `react/`, a client-side piece Ask 3 doesn't have.** Ask 3 is server-driven (a link/redirect); One Tap needs the GSI client library and a callback:

- A `<GoogleOneTap>` component that loads `https://accounts.google.com/gsi/client`, initializes with the public **Client ID** and our HMAC'd nonce, and on `credential` POSTs to `/auth/google/onetap`, then refetches `useWhoami`. Degrades silently (renders nothing / falls back to the Ask 3 button) when FedCM/One Tap isn't available or the prompt is dismissed.
- The Client ID is public by design (it's in the page); the secret stays server-side and is only used by the redirect flow's code exchange, not here.

**Why it's worth it:** it removes the two-page bounce for the common case (a signed-in Google user gets a one-tap prompt on first visit), which is the single biggest friction point Ask 3's "why" section is about. The cost is the client-side GSI dependency + FedCM's browser-support matrix + nonce/origin plumbing.

## Sequencing

mgu keeps CFA-as-IdP until Ask 1 lands (it works; this is streamlining, not a fire). Marin's mark-&-sweep sprint runs through 2026-08-28, so any dist-branch SHA that includes the adapter can be consumed after that. Watchy presumably migrates the same way later (same two-Function shape).

## Decisions (need from Ryan)

Ask 1 is shipped, so these are about how far to take the rest:

1. **Ask 3 (Google-first sign-in panel) — build now?** This is the FE that makes Ask 1 usable without CFA's hosted page. mgu can't fully drop CFA-as-IdP until *something* renders "Continue with Google." Likely yes; confirm.
2. **Ask 2 (email-code fallback) — build, or punt to the interim story?** The tail is ~4 non-Google addresses. The spec's interim answer (admin mints an email-bound grant, delivered to the claimed inbox = verification) needs no new code and covers those 4. Building `core/email-codes.ts` is real work (a pending-auth table, a `sendEmail` adapter, deliverability). Recommend **punt** unless you want self-serve for the tail now.
3. **Ask 4 (One Tap) — want it, and at what priority?** Additive polish on top of Ask 3. If yes: (a) **auto-prompt vs button-only** — the auto-surfacing One Tap prompt is lower-friction but can feel intrusive / has display caps; the rendered "Sign in with Google" button is calmer. (b) Priority relative to Ask 3 — I'd do Ask 3 first (it's the fallback One Tap degrades to) and Ask 4 as a follow-up.
4. **Google OAuth client** — Ask 1's consumer usage names a fresh client in `oa-internal-450019`. For One Tap the **Client ID** must be authorized for the app's web origin(s) and listed as a FedCM/One Tap origin. Is that client created, and do you want the demo (`auth.oa.dev`) wired as a live example, or is this consumer-side (mgu) only?
5. **CFA decommission** — Ask 1 landing was the gate for deleting mgu's Access app. Is that the mgu session's job (not this repo's), or do you want a note/checklist here?
