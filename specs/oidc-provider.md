# A small first-party OIDC provider (`@open-athena/auth/provider`)

Status: first cut implemented, 2026-10-25 (`src/provider/`, `test/provider.test.ts`, demo `/oidc` + `/rp`, `test-browser/live/broker.spec.ts`). This is the build-it-ourselves option for the broker in `specs/cross-service-sso.md`. It was built in parallel with a trial of Better Auth's OAuth 2.1 provider plugin; this one was chosen (2026-10-27, reasons in `cross-service-sso.md`, "Provider decision").

November 7 security correction: authentication freshness is explicitly unsupported rather than inferred from local cookie issuance. The source fix fails closed for `prompt=login`/`max_age`; the historical hosted result does not describe this modified implementation. See [conformance investigation].

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
    - `login`: unsupported; fail closed with `login_required` until verified active-authentication evidence can be propagated.
    - `select_account`: show the chooser.
  - Any valid `max_age`, including zero, is currently unsupported and returns `login_required` without starting a reauthentication loop. Local session issuance is not accepted as upstream authentication time.
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
- Claims are `email`, `email_verified: true` when `email` is requested, plus `name` / `picture` from the gate's profile when `profile` is requested (`picture` for a stored `data:` / `asset://` face is a short-lived `/oidc/picture/<ticket>` URL; see [`broker-picture-claim.md`](done/broker-picture-claim.md)), plus whatever an optional `claims({ email, client, scopes })` hook returns (e.g. `groups` from the directory snapshots). `policy({ email, client })` can refuse a person for one app (`access_denied`).
- `auth_time` is not emitted or advertised: the current session model has local issuance time, not verified upstream active-authentication evidence. A claims hook cannot set it. Discovery advertises only the `none` and `select_account` prompts.

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
  - Caller-supplied continuation markers cannot satisfy forced login; same-second `max_age=0` fails closed; ordinary tokens omit unverified `auth_time`. These source regressions do not prove upstream UI behavior.
- A **black-box probe** (`scripts/oidc-probe.mjs <issuer>`) runs checks over HTTP against any provider, ours or the Better Auth trial, for a like-for-like comparison. A historical hosted OpenID Foundation Basic OP run is recorded in [conformance results]; a new run requires separate authorization and cannot replace manual UI evidence.

## As built

- Freshness is deliberately unsupported after the November 7 investigation: caller-controlled `oa_login_after` bypassed forced login, same-second issuance satisfied `max_age=0`, and the Google chooser did not establish active reauthentication. The unsigned continuation mechanism is removed. `prompt=login` and any valid `max_age` fail closed; local `AuthenticationResult.issuedAt` is not emitted as `auth_time`. The broker's `/signin` refuses forced login rather than turning it into account selection. Ordinary sign-in and `select_account` remain distinct.
- Any token-endpoint attempt spends the code (taken before the checks), so a stolen code is worth one guess, and the right client can't use it afterwards either.
- The access token is a short-lived `at+jwt` whose `aud` is the userinfo endpoint; `/userinfo` re-checks the provider and client policy.
- Logout signs out of the broker (`gate.signOutCookies`: the active retained account, or the single session). It redirects only with a valid `id_token_hint` (expired is fine) and a registered `post_logout_redirect_uri`; otherwise it answers `Signed out.` in place.
- Demo: the dashboard's gate is the broker (issuer = request origin; a per-isolate key on localhost, `OIDC_SIGNING_KEY` required on auth.oa.dev), `/signin` honours `next` / `prompt`, with a chooser for `select_account`. App B (`/rp`) has its own gate and cookie, and its token and JWKS calls stay in-isolate.

- `oidcCallback` / `googleOneTapVerify` take `hostedDomain`: the id_token's `hd` must match, or it's a denial (`/?denied=`). An address at the domain isn't enough, since a consumer Google account can carry it with no `hd`. The broker's own Google sign-in should set it, with `authParams: { hd }`.
- A retained-mode broker with verified accounts but none selected (or only a guest active) answers `prompt=none` with `account_selection_required`, and sends an interactive request to the chooser (`prompt=select_account`) rather than a sign-in.

## Follow-ups (not in the first cut)

- Back-channel logout, and how revocation reaches downstream apps.
- Restore authentication freshness only with verified authentication time/provenance carried through the session model and a browser/request-bound, expiring, replay-protected continuation. Do not assume Google supports `prompt=login` or that selecting an account actively reauthenticates it.
- The hosted Basic OP result is historical; all four manual reviews remain open, and current source needs separately authorized hosted rerun/UI evidence after the freshness gap is resolved. See [conformance results] and [conformance investigation] for per-test dispositions and TFFP evidence. This fail-closed change is not a conformance pass.

[conformance results]: ../docs/conformance-results.md
[conformance investigation]: ../docs/conformance-investigation.md
