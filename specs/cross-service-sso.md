# Cross-service OA sign-in, without shared app cookies

Status: architecture proposal, 2026-10-19. Requested while rolling `@open-athena/auth` out across OA services. No broker, new credentials, DNS changes or deployments are implemented or authorized by this document. This is a separate scope decision from the existing relying-party library's "not becoming an IdP" position: a central broker issuing identity to apps **would** be a downstream identity provider, even when Google remains its upstream provider.

## What "zero tap" means

Zero clicks for an eligible returning visitor, not a promise of zero redirects or zero interaction forever. A local valid session already needs no login. When an app has no usable selected session, it can make a bounded top-level trip to a central login service and return with its own session. The broker can complete that trip without UI when it already has an unambiguous, valid OA login. First login, expired evidence, consent, account ambiguity, policy refusal or an explicit "use another account" may need interaction. Do not hide those cases behind redirect loops.

Google OIDC also supports `prompt=none` with a `login_hint` for existing authentication/consent. It returns an error when interaction is needed, not permission to skip authentication. This is a useful opportunistic path but not organization-wide session orchestration: the browser/app may lack a hint, different clients have different grants, and Google/browser UX remains outside our control. Hidden-iframe/third-party-cookie tricks are not the baseline.

## Recommended trust boundary

Use a dedicated broker deployment, provisionally `login.oa.dev`, **not** the public `auth.oa.dev` demo's gate. The demo intentionally accepts arbitrary emails and has public sandbox identities; it must never become OA's production identity authority. Google Workspace remains the upstream authenticator; the broker enforces OA's verified-identity policy and handles account selection. Prefer an established OIDC provider/broker implementation over implementing an authorization server inside this package. Provider/product selection and hosting remain open.

The broker keeps an HttpOnly, Secure, host-only `__Host-` cookie (`Path=/`, no `Domain`). Each app keeps its own host-only cookie and session secret/store. Neither a common HMAC signing key nor an `oa.dev` parent-domain session cookie is distributed to every app. Parent-domain cookies expose the shared credential to sibling servers and permit sibling cookie interference; one neglected service should not compromise every OA login. Separate registrable domains such as `openathena.ai` cannot share that cookie anyway, whereas top-level OIDC redirects can serve them.

## Browser and backend flow

1. App checks local authentication. A valid explicit guest/account selection remains active; an incidental broker session must not replace it. Explicit API Bearer requests never enter browser SSO redirects. An incoming share link follows the multi-login resolution policy, not an unconditional broker escalation.
2. With no usable local selection, the app creates a browser-bound login transaction (state, nonce and PKCE S256 verifier) and redirects to the broker's authorization endpoint. Client ID, exact registered redirect URI, requested identity scopes and an optional non-authoritative hint identify the request.
3. Broker validates the client and redirect. If its session is valid and selection unambiguous, it issues a short-lived, one-use code bound to that client, redirect URI and PKCE challenge. Otherwise it returns a standard no-interaction error or offers an interactive sign-in/selection path. There is no arbitrary `next` URL that can receive credentials.
4. App backend exchanges the code, validates issuer/audience/signature/nonce/expiry, then applies its **own** current email/group/resource policy and establishes a local session. Only a callback with matching state/browser transaction may select/add the account. The short-lived authorization code is delivered only to its registered callback and immediately stripped/exchanged; it must not be forwarded into unrelated URLs, localStorage, audit rows or analytics. Session, access and ID tokens never travel in those callback URLs.
5. The app sends the visitor to the original safe local destination, stripping callback parameters. It never automatically retries an `interaction_required`/`login_required` result indefinitely. Authentication at OA is not automatic authorization for every OA service.

For this backend-oriented app fleet, use authorization-code flow with PKCE and confidential client authentication where appropriate. No browser-held shared refresh credential. Token audiences and callback allowlists remain per app; a token issued for service A is not a credential for service B. The existing OIDC adapter needs a concrete interoperability/security review (discovery/provider capabilities, PKCE, error/callback handling, parameter overrides and relevant tests) before claiming broker compatibility beyond its tested configurations.

## Selection and logout

There are two separate selections: the broker's chosen upstream account and each app's selected local retained login. Preserve intentional choices in both. The multi-login registry remains app/gate scoped; it is not a cross-service cookie jar or a global union of permissions. A guest grant's attributed email never proves ownership of an OA identity.

Local sign-out removes the app's selected login and suppresses automatic bootstrap until the user explicitly resumes sign-in, so sign-out doesn't immediately sign them back in. "Sign out of OA" is a separately named broker/global action with defined downstream revocation semantics; destroying the broker cookie alone does not revoke already-established app sessions. Global revocation needs a measured policy (back-channel logout, authoritative checks, or bounded session TTL) and tests. No silent assumption of instant fleet-wide logout.

## Work packages

- **Library:** retain cloud-neutral OIDC relying-party support, robust noninteractive error handling, app-local sessions/authorization and the client/React split. Add broker-facing interoperability tests only against a selected provider contract; keep OA policy/config outside the generic library.
- **Broker service:** choose an existing implementation/provider, register OA's upstream Google client, enforce Workspace identity requirements, manage a distinct session store and register downstream apps. This service issues identity, not application access scopes by default.
- **App adoption:** registered callback/client configuration, an opt-in automatic bootstrap guard, local policy, and explicit local/global logout actions. Package helper defaults should handle loop prevention and typed error outcomes rather than every consumer writing their own redirect machinery.
- **Infrastructure:** reusable provider-specific Pulumi components can provision the selected hosting/store/secrets/callback configuration. Keep those libraries independent of OA's ops repository; do not hide manual provider setup behind a stub claiming full automation. No broad multi-cloud abstraction until the chosen stack supplies real inputs/outputs.

## Acceptance before rollout

Verify first login, app A then B with no click, deliberate guest retention, adding a second account, ambiguous-account fallback, expired broker evidence, denied app policy, missing consent, no-interaction failure without a loop, local sign-out without immediate re-login, and explicit global logout. Security tests cover exact redirects, PKCE downgrade/code replay, issuer/audience/state/nonce mismatches, cross-client exchanges and sibling-domain cookie injection. Browser checks cover OA's supported Chrome profiles and at least one cross-registrable-domain app. No production rollout follows from this proposal alone.

## Sources

- [Google OpenID Connect] documents `login_hint`, `prompt=none` and consent/error behavior.
- [OIDC Core] defines authentication requests and no-interaction errors.
- [Cookie scope and prefixes] explains Domain-cookie scope and host-only `__Host-` restrictions.

[Google OpenID Connect]: https://developers.google.com/identity/openid-connect/openid-connect
[OIDC Core]: https://openid.net/specs/openid-connect-core-1_0.html
[Cookie scope and prefixes]: https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Cookies
