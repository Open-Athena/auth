# Broker Logout and Revocation

Status: phase-one receiver/store foundation complete and ready for parent integration; full logout protocol remains proposed. User authorized only new `src/backchannel/**`, `src/adapters/d1-backchannel.ts`, `migrations/backchannel/**`, `test/backchannel*.test.ts`, and this spec. No commit, registration, deployment, or current-client support claim. Parent has wired package exports and dist checks and owns other docs/checkpoints. Conformance SA owns provider routes/tests and the broker prompt fix; this phase does not edit those files or core JWT/gate/retained/registry/OIDC files.

## Recommendation

Yes, implement optional OIDC back-channel logout, not a shared cross-app cookie or a bespoke unsigned webhook. Keep app sessions independent. Use existing WebCrypto RS256/JWKS code; no large OIDC dependency. The smallest sound feature includes durable session correlation and request-time enforcement, not just a notification sender. Follow [Back-Channel Logout] and harden the existing [RP-Initiated Logout] entry point before it can trigger fanout.

## Current Code

- [Provider routes] expose `/oidc/logout`, but only call `gate.signOutCookies`; a signed hint selects an allowed return URL, not downstream sessions. `/signout` in [Broker entry] is also local. Neither sends back-channel notifications. The provider currently accepts hintless logout without confirmation; do not extend this into silent global logout.
- [Provider store] holds authorization codes and spent-code revocation only. [Provider D1] has no broker-session/RP-participant ledger or delivery outbox. Five-minute ID/access-token expiry does not bound an RP session minted from an ID token.
- [RP adapter] verifies an ID token and calls `gate.signIn(claims.email, request)`, discarding issuer/subject/session correlation. [Session codec] cookies identify `e:<email>` or `g:<grant>` and have no unique SSO login ID. [Gate] rechecks local email policy on every request; that does not recheck broker policy or terminate an independently admitted RP session.
- [Retained store] already has independent login selectors and evidence lifetimes, but no upstream OIDC binding. [Retained runtime] resolves the active login, account listings, and selections separately. All three paths need revocation enforcement. Broker production does not currently enable retained mode.
- [Registry] and [Broker admin] have no back-channel registration fields. Existing clients must opt in after their receivers and enforcement are deployed. Do not infer support in disky or any other consumer from this investigation.

## Scope and Identity

| Action | Intended effect |
| --- | --- |
| App-local logout | End only that app's selected local login. No broker request or fanout. |
| Broker-local logout | End that broker login/cookie only. Existing app sessions remain independent. Keep this available and explicitly named. |
| Cross-app session logout | End one broker login and every enrolled RP session associated with it; leave other browsers and identities alone. |
| Subject-wide revocation | Explicit privileged operation across that subject's recorded broker sessions, including RP associations surviving broker-local logout. Separate from routine logout. |
| Account/client disable | Stop admission as well as revoke existing sessions. Logout alone permits a later fresh authentication. |

Never confuse gate `e:<email>`, stable broker OIDC `sub` (currently HMAC-derived from email), retained selector, native broker login ID, RP-local login ID, and OIDC `sid`. Introduce a fresh random native login ID on every successful broker sign-in; never derive it from email, timestamp, or cookie hash. Map each broker login/client pair to an opaque random `sid`; distinct broker logins must have distinct SIDs. Include it in enrolled-client ID tokens. RPs match `(issuer, clientId, sid)` and additionally verify `sub` when supplied; never select logout targets from an email parameter.

First release is a SID-required OA profile: enroll with `backchannel_logout_session_required: true`, always send SID-targeted events, and refuse sub-only tokens in this profile. Subject-wide revocation enumerates recorded SIDs, rather than teaching the first receiver to erase every session for an email. Generic sub-only interoperability is deferred: it needs an issuance cutoff/generation that cannot revoke a later fresh login when delivery is delayed. Registry metadata must not imply that broader profile exists.

## Required State and Hooks

### Phase-One API

Implemented foundation, with parent-wired `/backchannel` and `/backchannel/d1` package exports:

- `verifyLogoutToken(token, { issuer, clientId, jwksUrl, fetch?, maxLifetimeS?, clockSkewS? }, nowS?)` returns verified `LogoutEvidence` or null for invalid credentials; configuration/dependency faults throw. Evidence contains exact issuer/client/SID, optional subject, JTI, exact-compact-token SHA-256 digest, issued time and expiry. HTTPS issuer/JWKS, RS256, explicit logout type, SID, valid event object, finite integer clocks and no nonce are required. Defaults: 120-second lifetime, 30-second future-issued allowance; expiry is strict. JWKS fetches are pinned, redirect-disabled, timeout/size bounded and reuse existing `verifyRs256Jwt` crypto without editing it.
- `BackchannelStore.accept(evidence, nowS, retainUntil)` atomically returns `accepted`, `duplicate`, or `conflict`. This is a trusted server API, not an endpoint for unsigned evidence. A matching receipt cannot extend retention; changed-token JTI reuse or conflicting known SID/subject cannot create a receipt or mutate another target. Unknown SIDs get tombstones. New distinct valid events can extend but never shorten retention.
- `BackchannelStore.isRevoked({ issuer, clientId, sid }, nowS)` exposes logical expiry for future gate/callback checks; no email lookup or subject-wide erasure. `cleanup(nowS, limit?)` removes bounded expired rows per table. Receipt expiry does not delete a still-live SID tombstone.
- `backchannelLogoutReceiver({ ...verifierOptions, store, retentionS, now? })` returns an optional Request handler. `now` supplies epoch seconds. It accepts form POST, bounds streamed bodies, rejects duplicated parameters and invalid tokens before storage, and returns 200 for accepted/duplicate evidence or 400 for conflicts. Storage/dependency failures throw, so the host must produce a failure response, never a successful acknowledgment. It requires no browser cookie/Origin/selection context and sets no cookies. The adopter supplies retention covering its maximum local-session/callback lifetime; the factory enforces only the minimum cryptographic window, not an unenforceable cross-app lifetime promise.
- `memoryBackchannelStore()` and `d1BackchannelStore(db)` share the contract. Apply only `migrations/backchannel/0001_backchannel.sql` for the D1 receiver: receipt and revoked-SID tables, no existing schema changes. D1 tests exercise real SQL through Node SQLite, including no-op conflict guards and transaction rollback.

This is not an integrated logout feature. No endpoint is mounted automatically, discovery/registration is unchanged, no provider SID is issued, and no gate or current RP consults these tombstones yet. Existing provider `sub` remains HMAC-derived from email, with no usable session correlation. Existing cookies cannot be retrospectively matched to a SID. Exposing a live receiver as effective logout must wait for the correlation and request-time enforcement below. Host routing, rate limiting, JWKS operational caching/refresh, delivery retries and authoritative reads remain adopter/integration responsibilities.

Foundation validation: 61 focused tests pass, including signed Request-to-SQLite persistence, exact no-mutation snapshots on receipt/subject conflict, idempotent replay retention, cleanup boundaries and transactional rollback on a failed tombstone write. Full `pnpm typecheck` passes. An isolated scratch-copy mutation run kills all five deliberate faults: disabled logout-token type check, disabled duplicate-form guard, receipt replay overwrite, disabled subject-insert guard, and inclusive instead of strict expiry. Its unchanged baseline passes all 61 tests; reviewed implementation files are never mutated. Mutation reports are local scratch artifacts under `tmp/backchannel-mutations/`, not shipped code.

The following integrated-state names remain proposed. Keep stores separate from grant authority and activity feeds.

| State | Minimum fields and invariant |
| --- | --- |
| Optional `sso_sessions` track | `(gate_id, id)` primary key; local principal, issued/expiry times, revoked time; nullable upstream issuer/client/sub/SID tuple. Index upstream tuple and principal. A random local ID identifies each local login; no raw cookies or tokens stored. Broker-native sessions use the same local registry without an upstream tuple. |
| Cookie/retained binding | Optional signed `ssoSessionId` in an email cookie; nullable `sso_session_id` in retained rows. Preserve it through codecs, retained import/replacement/list/select/authenticate. No grant semantics change. |
| Provider extension | Authorization codes capture native broker session ID. `provider_rp_sessions` binds broker session, client, SID, OIDC sub, revoked time, and retention deadline. Unique broker-session/client pair and unique SID. Extend registry with nullable `backchannelLogoutUri` and `backchannelLogoutSessionRequired`, propagated through static config, lookup, admin, and CLI. |
| Provider outbox | Unique logical delivery per revocation/participant; registered endpoint revision, target SID/sub/client, attempts, next-attempt time, lease, deadline and outcome. Persist session revocation and delivery intent in the same transaction. |
| RP receiver state | `oidc_revoked_sids` keyed by issuer/client/SID with subject and retention deadline; `oidc_logout_receipts` keyed by issuer/client/JTI with payload digest and expiry. Revoke matching local SSO rows, write tombstone, and record receipt atomically. Unknown SID still gets a tombstone. |

Gate integration: optional SSO-session store; extend `signIn` to accept server-verified upstream evidence and create a local row before emitting cookies. Return/expose the verified local session ID internally in `authenticateResult`, not as public account authority. `resolveClaims` checks the row, its principal binding, expiry and revocation before live policy. Thread the ID through retained resolution too; revoked retained logins disappear from choices and never cause automatic selection of another identity. Local logout/remove/end-browser invalidate their corresponding local rows without implicit upstream fanout; compose this atomically with existing retained selection/CAS guards in the same database, never revoke a login after a stale selection fails. Storage faults deny access or produce a service error, never fall back to accepting the cookie.

RP callback integration: after normal ID-token/nonce/email checks, require nonempty verified issuer/sub/SID for the enabled profile and attach that tuple to `gate.signIn`. Atomically refuse a tuple already tombstoned. If logout races registration, either the row is included in revocation or its later registration is refused. No unrelated direct-Google, email-code, grant, or different-issuer session is a target.

Provider integration: `/authorize` captures the authenticated broker session; `/token` must atomically check it is live and register the RP participant before returning tokens. Revocation serializes against registration: a revoked session cannot produce an untracked token after fanout enumeration. Add protected `sid` to reserved claims; bind access tokens to their provider session as well and reject revoked bindings at `/userinfo`, retaining spent-code and policy checks. Do not claim arbitrary external JWT verifiers can recall an already-issued token.

Use conditional SQL and atomic [D1 batches], not a JavaScript read/check/write sequence; false conditional writes require explicit result checks because they are not SQL errors. Broker sessions, provider participants, and outbox must share the broker database. RP sessions, tombstones, and receipts share each RP's database. Authentication/revocation reads must not use stale caches or replica reads without an appropriate consistency guarantee.

## Receiver and Delivery

Protocol: form-encoded POST containing one `logout_token`; discovery advertises back-channel and session support only when enabled. Signed claims include `iss`, `aud`, `iat`, `exp`, `jti`, SID, optional subject, and `events: {"http://schemas.openid.net/event/backchannel-logout": {}}`; no nonce. Use the existing issuer keys. This follows [Back-Channel Logout], sections 2.1-2.8.

OA receiver defaults: pinned issuer/JWKS/client, RS256, `typ=logout+jwt`; verify signature, required claim types, audience, finite timestamps, freshness, event object, SID and subject binding; reject nonce and unsupported critical headers. Never fetch a token-supplied key URL. Configure 120-second maximum lifetime and 30-second future clock allowance. A duplicate JTI with identical payload is an idempotent success, not another mutation; conflicting payload is invalid. Return 200 for valid already-ended/unknown sessions, 400 for invalid tokens, and never acknowledge storage failure. Keep token, cookie, and secret values out of logs.

Extend [JWT verifier] narrowly to expose/check authenticated type and enforce finite time claims for this receiver; its current generic issuer/audience/expiry check alone is insufficient. Do not weaken ID-token checks or allow logout tokens as login credentials. Keep state, nonce, confidential-client authentication, exact redirects, and S256 PKCE unchanged. The existing explicit per-client PKCE exception is not a reason to disable PKCE for OA clients; logout itself has no PKCE exchange.

Back-channel receiver is server-to-server: no browser cookie, selection header, browser CSRF token, or Origin requirement. The signed event authorizes only its bound session revocation. Apply body/token size limits, duplicate-parameter rejection, rate limits and bounded JWKS fetches. Ignore unrelated optional form values. Disable CORS credentials.

Delivery URIs are a new SSRF surface, not interchangeable with browser redirects: require explicitly registered HTTPS OA service destinations, no credentials/fragments, no loopback/private/link-local/metadata destinations in production, and no redirect following. Do not reuse the registry's loopback callback exception for production delivery. Keep localhost delivery local-test-only; a production broker cannot reach the developer's localhost. Revalidate endpoint revision at send time; suspend changed/removed destinations for reviewed requeue. Client disable must retain the trusted cleanup destination independently of active `clientLookup`, so cleanup is not silently lost.

Persist first, attempt bounded parallel delivery, then retry transient network/429/5xx failures with exponential backoff and jitter from a scheduled outbox drain. Permanent receiver errors remain visible. Reuse an unexpired attempt's JTI; mint a fresh short-lived token for a later retry after expiry, preserving the same revoked SID. A worker lifetime promise alone is not a durable retry mechanism. No Queue/DO dependency is required initially.

Retain participant records, their subject/broker-session correlation, and RP tombstones through the configured maximum RP session lifetime plus callback/token/skew windows, not merely the five-minute ID-token lifetime. Default enrollment cap: 30 days; enrolled RPs must enforce it, including retained sessions. Outbox retry deadline cannot exceed this retention horizon. Cleanup must not remove a pending target or permit a late callback to revive it. A received event cannot delete browser cookies remotely; deny on the next protected request and use existing session-loss handling to expire them.

## Trigger Security and Limits

Add explicit same-origin, CSRF-protected POST actions for cross-app logout and privileged subject revocation; never silently repurpose app-local logout. A valid expired ID-token hint can aid session correlation, but is not authority for subject-wide revocation. At `/oidc/logout`, validate hint purpose/client/sub/SID and its relationship to the current broker login; require confirmation for no hint or a mismatched login before any logout/fanout, following [RP-Initiated Logout]. Preserve exact registered return-URL checks. A GET must not directly cause new cross-app revocation.

Subject revocation covers broker-session records committed at its serialization point, including ended broker sessions with live RP associations. Later genuinely fresh authentication is allowed unless a separate authoritative account/client policy blocks it. Policy changes do not automatically emit events today: add an explicit integration hook at the authoritative mutation/sync owner, not a side effect of evaluating an email-policy function. Static domain policy alone cannot detect Workspace suspension. Disabling a broker client currently blocks provider requests, not app-local sessions.

Guarantee only enrolled sessions after rollout: broker revocation is immediate locally; downstream enforcement begins after successful delivery. During an outage, an RP can remain authenticated until retry succeeds or its capped session expires. Existing requests, streams, cached app data, and unrelated job/API credentials are not retroactively canceled. Stronger bounded remote revocation needs an additional fail-closed lease/introspection mechanism; do not advertise universal instant logout.

## Phases and Acceptance

1. Foundation complete: signed verifier, optional Request receiver, atomic receipt/SID tombstone memory and D1 stores, optional migration, 61 focused tests and five killed guard/boundary mutants. Parent has wired exports/dist checks; full typecheck passes. No mounted route or existing-session effect.
2. Next, after API/ownership confirmation: optional gate SSO evidence and stores, codec/retained propagation, RP callback binding and enforcement, provider participant/outbox stores, SID issuance and discovery/registry plumbing. Keep defaults off. Enabled gates reject legacy unbound email cookies/retained rows and require reauthentication rather than inventing provenance. Other gates remain unchanged.
3. Wire broker session-logout POST, RP-initiated confirmation, scheduled drain, registration controls and delivery observability; enable with two local test RPs. Subject-wide backend operation can reuse the same atomic SID enumeration; defer account-disable UI and directory-sync wiring until their owning agents agree on the integration contract.
4. Upgrade one real RP with its own store/migrations and canonical reachable endpoint, enforce the lifetime cap, then register it and enable broker delivery. Each other app adopts independently; use cross-project specs for its owner. Pilot checks precede separately authorized production rollout. Rollback stops new enrollment/delivery without removing request-time checks, tombstones, or resurrecting revoked rows.

Acceptance tests must compare exact structured outcomes:

- Two RPs, two browsers of the same subject, and another subject: app-local and broker-local logout do not fan out; cross-app session logout affects only matching SIDs; explicit subject-wide revocation covers that subject's recorded sessions only. No account auto-switch. Include a retained RP with inactive and replaced logins.
- Replay, unknown/already-ended SID, SID/sub mismatch, wrong issuer/client/key/algorithm/type, ID/access token substitution, missing claims, nonce, malformed events, nonfinite/future/expired timestamps, duplicate parameters and body limits. Invalid input makes no storage mutation; failed storage is not success.
- Logout before/during callback, code exchange during revocation, duplicate delivery after lost response, concurrent drains, expired retry JWT, key rotation, registry disable/endpoint change, outage recovery, and tombstone/participant cleanup boundaries. Fresh distinct SIDs survive delayed old events.
- D1 runtime concurrency/rollback tests as well as memory-store tests; single-cookie and retained paths both tested. Preserve existing PKCE/state/nonce, policy, grant and profile behavior. Add a provider/RP flow proving an expired ID token does not end the independently capped local session, but received logout does.
- Before visible rollout, CIC broker confirmation and pilot RP session-loss behavior; prove the receiver works without browser cookies and server restarts do not lose pending delivery. No UI behavior was changed or browser-tested during this investigation.

[Back-Channel Logout]: https://openid.net/specs/openid-connect-backchannel-1_0.html
[RP-Initiated Logout]: https://openid.net/specs/openid-connect-rpinitiated-1_0.html
[D1 batches]: https://developers.cloudflare.com/d1/worker-api/d1-database/#batch
[Provider routes]: ../src/provider/routes.ts
[Provider store]: ../src/provider/store.ts
[Provider D1]: ../src/adapters/d1-provider.ts
[Broker entry]: ../broker/src/index.ts
[RP adapter]: ../src/adapters/oidc.ts
[Session codec]: ../src/core/session.ts
[Gate]: ../src/core/gate.ts
[Retained store]: ../src/core/retained-store.ts
[Retained runtime]: ../src/core/retained.ts
[Registry]: ../src/provider/registry.ts
[Broker admin]: ../broker/src/admin.ts
[JWT verifier]: ../src/core/jwt.ts
