# A small first-party OIDC provider (`@open-athena/auth/provider`)

Status: first cut implemented, 2026-10-25 (`src/provider/`, `test/provider.test.ts`, demo `/oidc` + `/rp`, `test-browser/live/broker.spec.ts`). This is the build-it-ourselves option for the broker in `specs/cross-service-sso.md`. It's being built in parallel with a trial of Better Auth's OAuth 2.1 provider plugin (report at `tmp/oidc-trial/better-auth/REPORT.md`, untracked). Whichever wins, nothing is provisioned (`login.oa.dev` DNS, Google client, D1) without an explicit go-ahead.

## Why this can be small

The broker serves a fixed list of OA's own apps. It needs no dynamic client registration, no third-party consent screens, no implicit or hybrid flows, no public clients, and no refresh tokens. Each app is a confidential server-side client that wants one identity per sign-in. The broker's own sign-in already exists: a gate with Google OIDC and emailed codes, sessions, and (`retained` mode) several accounts per browser with a chooser. So the provider is a thin layer over a gate: it turns "this browser is signed in at the broker as X" into an ID token for a registered app.

## Scope

**Endpoints**, from `oidcProviderRoutes({ gate, issuer, clients, keys, store, … })`, a `(req) => Promise<Response | null>` handler:

- `GET /.well-known/openid-configuration`: discovery, with `issuer` exactly as configured.
- `GET <base>/jwks`: the public signing keys.
- `GET <base>/authorize`:
  - Authorization code only (`response_type=code`); `openid` scope is required.
  - PKCE S256 is required; `plain` is refused.
  - `state` is passed through; `nonce` goes into the ID token.
  - `prompt` handling:
    - `none`: no UI, ever. Success, or the error `login_required` / `account_selection_required` / `access_denied`.
    - `login`: sign in again.
    - `select_account`: show the chooser.
  - `login_hint` is passed on to the sign-in page.
  - The response includes `iss`, per RFC 9207.
- `POST <base>/token`:
  - `authorization_code` grant only.
  - Client authentication by `client_secret_basic` or `client_secret_post`.
  - The code is single-use and taken atomically. It is bound to its client, redirect URI and PKCE challenge, and lives 60 s.
  - The response carries `id_token`, plus a short-lived signed `access_token` that is good only at `/userinfo`.
- `GET|POST <base>/userinfo`: takes a Bearer access token.
- `GET <base>/logout`: RP-initiated logout. Needs an `id_token_hint` from this issuer and a `post_logout_redirect_uri` registered for that client. It signs the browser out of the broker only; app sessions are separate (see `cross-service-sso.md`, "Selection and logout").

**Errors**: an unknown client, or a redirect URI that isn't an exact match, gets an error page and never a redirect, so the broker can't be used as an open redirect. Every other error is redirected back to the registered URI with `error`, `state` and `iss`.

**Identity**:
- Only an SSO login at the broker (`auth.kind === 'sso'`, a verified email) can sign in to an app. A share-link session at the broker never can.
- `sub` is a stable, opaque value derived from the principal (`HMAC(subjectKey, "e:" + email)`), the same for every client. Make it pairwise later if ever needed.
- Claims are `email`, `email_verified: true`, plus `name` / `picture` from the gate's profile when `profile` is requested, plus whatever an optional `claims({ email, client, scopes })` hook returns (e.g. `groups` from the directory snapshots). `policy({ email, client })` can refuse a person for one app (`access_denied`).

**Clients** are a static registry in config (`id`, a hash of the secret, exact `redirectUris`, `postLogoutRedirectUris`, an optional per-client policy). This deliberately has no admin UI or database table: adding an app is a reviewed config change.

**Keys**:
- RS256 private JWKs, passed in (a Worker secret).
- The first key signs, and all of them are published, so rotation means adding a key, then later removing the old one.
- RS256 because every RP we have (`verifyRs256Jwt`) and Google's ecosystem expect it.
- `generateSigningKey()` (and a script) makes one.

**Storage**: only authorization codes, through `ProviderStore { putCode, takeCode }`. There's a D1 adapter (`/provider/d1`, its own migration track `migrations/provider/`) and a memory one (`/testing`). Everything else is stateless or is the gate's.

## The relying-party side (`/oidc`)

Apps sign in through the broker with the existing `oidcStart` / `oidcCallback`, given an `OidcProvider` for the broker. Two additions are needed, and Google benefits from both too:

- **PKCE S256**: the verifier is `HMAC(gate.secret, "pkce:" + nonce)`, so it stays storage-free like `state`.
- **Error callbacks**: a callback carrying `error` (`login_required` after a `prompt=none` attempt, `access_denied`, …) redirects to the app with `?sso=<error>`, not a bare 400. That lets an app try silent sign-in once, then fall back, with no loop.

## Tests

The suite runs in process, with `oidcStart` / `oidcCallback` (the real RP) against `oidcProviderRoutes` via an injected `fetch`, using a cookie jar per browser. It covers:

- **Sign-in flow**:
  - First sign-in through the broker's login.
  - Then app B with no interaction (the "zero tap" case).
  - `prompt=none` with no broker session gives `login_required`, with no loop.
  - `select_account` sends the browser to the chooser.
  - A refusal from `policy` gives `access_denied`.
  - Logout.
- **Attacks that must fail**:
  - A redirect URI that doesn't match exactly (trailing slash, extra query string).
  - An unknown client.
  - Code replay; a code redeemed by the other client; the wrong PKCE verifier.
  - Missing PKCE, or `plain` PKCE.
  - A bad client secret.
  - `state` passthrough must hold; the RP must refuse a nonce mismatch.
  - A token signed with another key or another `alg`; an expired code.
  - A share-link session at the broker.
- A **black-box probe** (`scripts/oidc-probe.mjs <issuer>`) runs the same checks over HTTP against any provider, ours or the Better Auth trial, for a like-for-like comparison. Later, run the OpenID Foundation conformance suite's Basic OP plan, which needs Docker.

## As built

- `AuthenticationResult.issuedAt` (the session's `iat`, or a retained login's `issuedAt`) gives `auth_time`, `max_age` and an honest `prompt=login`: `/authorize` sends the browser to sign in with `oa_login_after=<now>` added to `next`, and only a session minted at or after that satisfies it, so neither an older session nor a dropped `prompt` loops or slips through.
- Any token-endpoint attempt spends the code (taken before the checks), so a stolen code is worth one guess, and the right client can't use it afterwards either.
- The access token is a short-lived `at+jwt` whose `aud` is the userinfo endpoint; `/userinfo` re-checks the provider and client policy.
- Logout signs out of the broker (`gate.signOutCookies`: the active retained account, or the single session). It redirects only with a valid `id_token_hint` (expired is fine) and a registered `post_logout_redirect_uri`; otherwise it answers `Signed out.` in place.
- Demo: the dashboard's gate is the broker (issuer = request origin; a per-isolate key on localhost, `OIDC_SIGNING_KEY` required on auth.oa.dev), `/signin` honours `next` / `prompt`, with a chooser for `select_account`. App B (`/rp`) has its own gate and cookie, and its token and JWKS calls stay in-isolate.

- `oidcCallback` / `googleOneTapVerify` take `hostedDomain`: the id_token's `hd` must match, or it's a denial (`/?denied=`). An address at the domain isn't enough, since a consumer Google account can carry it with no `hd`. The broker's own Google sign-in should set it, with `authParams: { hd }`.
- A retained-mode broker with verified accounts but none selected (or only a guest active) answers `prompt=none` with `account_selection_required`, and sends an interactive request to the chooser (`prompt=select_account`) rather than a sign-in.

## Follow-ups (not in the first cut)

- `picture` for `asset://` / `data:` avatars (only `https:` URLs are passed through today).
- Back-channel logout, and how revocation reaches downstream apps.
