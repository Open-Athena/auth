# Conformance investigation

## Scope and evidence

Investigated November 7, 2026, starting from worktree HEAD `7ad016df02a5fc199f01dcb27decc5449b9ed70b`. The [recorded hosted result][results] is historical: Basic OP, discovery/static-client variants, suite v5.3.4, plan `fM45FwelhwWch`, 20 passed / 6 warnings / 4 reviews / 5 skips. It is not certification or a result for the modified source below.

Evidence inspected: provider/broker source and tests; public-discovery snapshots `tmp/auth-disc.json`, `tmp/disc-auth.oa.dev.json`, `tmp/disc-login.oa.dev.json`; and the existing local suite clone `/Users/ryan/c/openid/conformance-suite`, clean at `release-v5.3.4`, commit `23353b36957d6466010de767c812d2c91ed37638`. Its test modules are available; some condition classes are absent from the sparse/partial clone and could not be read from local Git objects. No conclusions below depend on pretending those condition implementations were inspected.

No hosted per-test logs or review screenshots were found in the inspected local evidence. Warning explanations below distinguish mechanisms reproduced from current source from the exact historical condition, which remains unverified without those logs. The five skip identifiers are reconstructed from the recorded categories and matching suite plan, not independently read from the hosted plan. No browser access, hosted test, deployment, publication, client registration, or credential transmission was performed. Neither `.envrc`, the secret-bearing `tmp/oidc-conformance/config.json`, nor conversation transcripts were read.

## Confirmed defects and bounded fix

1. **High: account selection manufactured authentication freshness.** Before this patch, the provider used `authenticateResult().issuedAt` as `auth_time`; the [broker sign-in mapping][broker] turned forced login into `account=choose`; the [OIDC adapter][adapter] sent `prompt=select_account`, then minted a new local session without validating an upstream authentication time. This establishes neither active reauthentication nor its time. Existing [provider integration tests][provider-tests] simulated sign-in by calling `gate.signIn` directly; they did not exercise Google's UI. Core distinguishes active reauthentication from account selection and equates `max_age=0` with forced login. [Authentication request requirements][core-auth].
2. **High: a caller could supply the internal continuation marker.** In the original `src/provider/routes.ts:243`, `Number(oa_login_after)` controlled whether forced login was required. An authenticated request with `prompt=login&oa_login_after=0` obtained a code using a 90-second-old session. Empty and negative values also bypassed the prompt. This is a freshness bypass for an existing authenticated session, not sign-in without credentials or a redirect allowlist bypass.
3. **Medium: same-second sessions satisfied `max_age=0`.** The original `nowS - authTime <= maxAge` comparison allowed a code without another authentication when session issuance and authorization shared an epoch second. An in-memory probe of the actual route reproduced this independently of the marker defect.

The user approved a bounded fail-closed fix rather than inventing upstream evidence. [Authorization][authorize] now returns a single `login_required` error with `error_description=Verified authentication freshness is not supported` for `prompt=login` or any syntactically valid `max_age`, before issuing a code or redirecting to sign-in. Client/redirect/PKCE validation still precedes this decision. The unsigned continuation mechanism is removed. Ordinary sign-in, unconstrained silent sign-in and account selection remain available.

[ID tokens][tokens] no longer emit local-session issuance as `auth_time`, including when an outstanding code record contains a non-null legacy `authTime`. Claims hooks still cannot forge it. [Discovery][discovery] no longer advertises `auth_time` or the `login` prompt. Code records retain their existing nullable field with `authTime: null`; no store/schema change was needed. Direct broker `/signin?prompt=login` also refuses rather than invoking a chooser, including in local developer sign-in mode. No change to `gate.ts` was made.

**This reduces capability intentionally.** It does not make `prompt-login`, `max-age-1`, or `max-age-10000` pass conformance. Do not reuse the old passing tally as a claim about this patch. Removing an advertised prompt does not waive Core reauthentication requirements; the provider remains incomplete for that capability.

## Six warnings

Names below use the `oidcc-` module prefix omitted in the recorded summary. Module sources live under `src/main/java/net/openid/conformance/openid/` in the [local suite][suite].

| Test | Actual evidence and interpretation | Disposition / next test |
| --- | --- | --- |
| `oidcc-userinfo-post-body` | `OIDCCUserInfoPostBody.java` deliberately warns on an HTTP error for optional body-token transport. [UserInfo][userinfo] reads only the Authorization header; a synthetic valid token in a form POST received exactly `401`, `WWW-Authenticate: Bearer`, `{"error":"invalid_request"}`. | Accept as an explicit unsupported transport, not a security failure. Optional implementation should first test body-only success, header/body conflicts even with identical tokens, duplicate body fields, wrong media type and GET bodies. Do not implement it merely to change the badge. |
| `oidcc-scope-profile` | `OIDCCScopeProfile.java` requests profile; its base class warns on returned claims. [Claim construction][claims] returns a stored name/picture only when available and profile-scoped. A synthetic named subject returned `name` in UserInfo; the broker has a profile store and the adapter seeds profiles, but that does not prove the tested historical user's row contained a name. | Historical cause unresolved: obtain the named warning condition and claim keys. Add exact fixtures for named subject, missing profile and scope omission. Do not fabricate a name or require every profile claim. |
| `oidcc-scope-email` | `OIDCCScopeEmail.java` explicitly warns on email claims in the ID token when the code flow also issues an access token. [Token construction][tokens] intentionally spreads the same scope-gated claims into both ID token and UserInfo. A local probe confirmed `{email,email_verified}` in both for `openid email`, neither in the ID token/UserInfo for `openid`. | Strong source-backed explanation, not confirmation of the historical log. No reproduced out-of-scope UserInfo/ID-token disclosure. Keep the current first-party convenience behavior pending a compatibility decision, or split ID-token/UserInfo projections and update consumers. The [scope-placement rule][core-scopes] explains the suite warning. |
| `oidcc-alternate-happy-flow` | `OIDCCAlternateHappyFlow.java` extends the email-scope test, reversing scope and query order. Local `openid email` and `email openid` produced identical claim-key sets and both exchanges succeeded. It inherits the email-in-ID-token warning. | Treat as the same likely claim-placement issue, not evidence of order dependence. Add a parameter-order permutation regression with exact normalized responses; inspect the actual condition before closing the historical warning. |
| `oidcc-ensure-request-with-acr-values-succeeds` | `OIDCCEnsureRequestWithAcrValuesSucceeds.java` says unknown/unavailable requested contexts may succeed without `acr`, producing WARNING. Discovery advertises no ACR values; the route ignores `acr_values` and emits none by default. | Accept no assurance claim. Add a test requesting unavailable ACR values and comparing the full normalized ID-token claims. Do not echo requested values or assert MFA. Any future ACR policy needs evidence of the authentication actually performed. |
| `oidcc-claims-essential` | `OIDCCClaimsEssential.java` requests essential `name` in UserInfo for code flow and warns when absent. [Discovery][discovery] explicitly says `claims_parameter_supported=false`; [claim construction][claims] does not process `claims`. A synthetic request with only `openid` plus essential name succeeded and UserInfo was exactly `{sub}` despite a named subject. | Accept optional-claims-parameter limitation; this need not be the same data problem as scope-profile. Essential requests do not justify inventing data. [Claims-parameter support][core-claims] is optional. Add an exact regression for ignored essential name; implementing claims projections would be a separate reviewed feature. |

The duplication decision is not a trivial removal: the [RP callback][adapter] currently obtains email from the ID token and does not fetch UserInfo for identity. Moving email exclusively to UserInfo requires the consumer to fetch it, verify `sub` equality, and retain verified-email/domain admission checks. Changing only provider serialization would break existing first-party login.

## Four reviews

**All remain OPEN as hosted manual reviews.** Source tests and local HTTP checks cannot substitute for the requested screenshot, reviewer identity and timestamp. These reviews were not completed because the correct browser/profile and hosted evidence were unavailable; no other identity was tried.

| Test | Suite requirement and source assessment | Evidence needed to close |
| --- | --- | --- |
| `oidcc-prompt-login` | `OIDCCPromptLogin.java` requests a second login screenshot and compares authentication times if present. The pre-fix chooser/local-time path was insufficient; current source explicitly refuses unsupported freshness. | After genuine reauthentication support exists, record first/second flows, the second active authentication UI, verified authentication times, issuer/build, reviewer and timestamp. A chooser screenshot alone is insufficient. Current fail-closed behavior must not be relabeled as PASS. |
| `oidcc-max-age-1` | `OIDCCMaxAge1.java` waits before the second request, requires recent/later `auth_time`, and requests second-login UI evidence. It now receives an explicit refusal instead of fabricated time. | Same authenticated-evidence chain as above, with verified age within requested bounds. Existing tests of local cookie age never close this review. |
| `oidcc-ensure-registered-redirect-uri` | `OIDCCEnsureRegisteredRedirectUri.java` appends a random suffix and expects a local error-page screenshot, never a callback. [Authorize][authorize] exact-matches the registered URI before redirecting; existing tests cover trailing slash, added query, other host/client and empty URI with exact `[400,null]` status/Location. | Preserve the actual hosted request and screenshot of the invalid-redirect response with no Location; identify the registered URI and reviewer. Add exact response-body/header assertions for the suite-style randomized suffix. No source defect found in this check. |
| `oidcc-ensure-request-object-with-redirect-uri` | `OIDCCEnsureRequestObjectWithRedirectUri.java` puts a valid URI inside an unsigned object and an invalid URI outside. With request objects unsupported, the provider validates the outer URI first and returns its local 400 page; it does not decode the object or redirect to its inner URI. That explains REVIEW despite unsupported request objects. | Capture the exact outer/inner URI request, invalid-redirect page and absence of callback. Add a paired regression: invalid outer URI plus object -> exact local 400/no Location; valid outer URI plus object -> exact registered error redirect with `request_not_supported`. Do not implement request objects to clear this review. |

## Five skips

These are the expected module identities from [the Basic plan][suite-plan], consistent with the recorded skip categories. Exact historical skip reasons still require per-test logs.

| Expected test | Code-backed reason | Disposition |
| --- | --- | --- |
| `oidcc-scope-address` | `OIDCCScopeAddress.java` selects address; `AbstractOIDCCReturnedClaimsServerTest.java` skips scopes missing from discovery. Current and saved discovery list only openid/email/profile. | Intended unsupported personal data. Keep scope unadvertised and verify exact granted scope/claims when requested. |
| `oidcc-scope-phone` | Same scope-support mechanism, via `OIDCCScopePhone.java`; phone is absent from discovery. | Intended unsupported personal data; same negative regression. |
| `oidcc-scope-all` | `OIDCCScopeAll.java` requests email/phone/address/profile, including unsupported scopes. | Expected consequence of unsupported address/phone, not evidence that email/profile failed. |
| `oidcc-unsigned-request-object-supported-correctly-or-rejected-as-unsupported` | `AbstractOIDCCRequestObjectServerTest.java` skips on `request_not_supported`. Discovery has `request_parameter_supported=false` but omits the signing-algorithm array: `skipTestIfNoneUnsupported()` in `AbstractOIDCCServerTest.java:430` skips only when an explicit array excludes `none`. Thus the actual request/rejection path can run before SKIP. | Intended unsupported feature. Do not claim the skip must have been triggered by discovery alone. Add the valid/invalid outer-URI pair described above; preserve `request_not_supported`. |
| `oidcc-refresh-token` | `OIDCCRefreshToken.java` skips after a token response without a refresh token. Provider advertises only authorization_code and returns no refresh token/offline_access capability. | Intended narrow credential lifecycle. Add an exact token-response shape/no-refresh assertion and `refresh_token` grant rejection. No reason to add refresh tokens for this badge. |

## Verification and next gates

TFFP was performed with exact structured assertions in [new reauthentication tests][reauth-tests] and updated existing provider tests, before implementation changes: 18 failures / 37 passes, including all 13 new provider regressions failing. After the provider fix, the same two files passed 55/55. Adding three real-broker `/signin` cases produced 58/58 passing tests. The test imports the broker entry point with source-backed package mocks; exact provider and provider/D1 aliases avoid using stale `dist/` code. Coverage also checks legacy non-null code-record times cannot reintroduce `auth_time`, a claims hook cannot forge it, no code is stored on freshness refusal, and ordinary sign-in/account choice remain distinct.

Local logs: `tmp/conformance-reauth-before.log`, `tmp/conformance-reauth-after.log`, `tmp/conformance-reauth-source-broker-final.log`. They contain synthetic test fixtures, not hosted credentials. Broker typechecking passed (`pnpm exec tsc --noEmit -p broker/tsconfig.json`); targeted strict typechecking of both provider test files and their source dependencies passed using the root compiler options. Full Vitest at that checkpoint: 1054 passed, 2 skipped, 13 failed, with every failure in concurrent `test/activity-routes.test.ts` due to a missing `activity_kind_settings` table. Root `pnpm run typecheck` reported the same concurrent file's missing `requireAdmin` option at line 31. Those activity files are owned by the parent and were not changed here; see `tmp/conformance-reauth-full-tests.log` and `tmp/conformance-reauth-typecheck-final.log`. These results do not claim the concurrently changing whole worktree is green.

No UI/CIC verification was possible with the unavailable approved browser profile. The broker response assertions exercise its actual request handler locally, not Google's UI or hosted manual-review evidence. No dev server, deployment or new hosted test was started.

Restoring freshness safely requires decisions outside this patch:

1. Choose an upstream authentication mechanism that actually supplies trustworthy active-authentication evidence. Do not assume Google accepts `prompt=login`, that a chooser authenticates again, or that a newly issued upstream ID token proves recent authentication.
2. Carry verified authentication time/provenance through the shared session model separately from cookie issuance. Specify treatment of upstream missing/stale/future time, unsupported parameters, existing sessions and account switches. Coordinate with the `gate.ts` owner before changing it.
3. Bind any continuation to the browser and exact validated authorization request, including client, URI, state/nonce and freshness requirements. Use authenticated state plus expiry and replay protection, or server-side single-use state. A signed timestamp alone is not sufficient. Preserve the original constraints across return, verify evidence before clearing them, and terminate with an error if evidence is unavailable rather than loop.
4. Add exact regression coverage for marker tampering, another browser/client/request, replay, stale/missing proof, same-second `max_age=0`, failure/cancellation, and a successful proof-carrying flow. Only then consider authorized UI review and a new hosted run.

The warning follow-ups and four manual reviews remain separate from the code fix. Before sharing any evidence, obtain the actual condition logs privately and sanitize tokens, emails, pictures and configuration; do not use publishing/certification as an assumed private download path.

[results]: conformance-results.md
[suite]: /Users/ryan/c/openid/conformance-suite/src/main/java/net/openid/conformance/openid/
[suite-plan]: /Users/ryan/c/openid/conformance-suite/src/main/java/net/openid/conformance/openid/OIDCCBasicTestPlan.java
[broker]: ../broker/src/index.ts
[adapter]: ../src/adapters/oidc.ts
[authorize]: ../src/provider/routes.ts
[tokens]: ../src/provider/routes.ts
[claims]: ../src/provider/routes.ts
[discovery]: ../src/provider/routes.ts
[userinfo]: ../src/provider/routes.ts
[provider-tests]: ../test/provider.test.ts
[reauth-tests]: ../test/provider-reauth.test.ts
[core-auth]: https://openid.net/specs/openid-connect-core-1_0.html#AuthRequest
[core-scopes]: https://openid.net/specs/openid-connect-core-1_0.html#ScopeClaims
[core-claims]: https://openid.net/specs/openid-connect-core-1_0.html#ClaimsParameter
