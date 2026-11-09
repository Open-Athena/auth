# Groups at sign-in: a deferred SAML adapter

Status (2026-11-09): **deferred, not built**. The original 2026-09-22 HCCS design below explored signed group attributes at sign-in without a standing directory credential. Its no-broker rationale is superseded: OA implemented and deployed `login.oa.dev`, using this package's OIDC provider ([broker design]). The current Groups direction is the implemented freshness-bounded [snapshot policy] and the pending [Groups setup draft], not SAML. Neither SAML assertions nor broker identity tokens provide ongoing revocation of existing app permissions without additional enforcement.

## The load-bearing fact

Google's OIDC id_token **never carries Workspace group membership** — by design. "Sign in with Google" (`accounts.google.com`) returns `email`, `hd`, `name`, `picture`, `sub`, and nothing about groups. This is a Google-specific gap, not a gap in OIDC: enterprise IdPs (Okta, Entra, Auth0, Keycloak) *do* emit a `groups` claim when configured. Google just doesn't, over OIDC.

So any group-awareness requires a directory lookup *somewhere*. The question is only where and when. The mechanisms differ in observation time and ongoing enforcement:

| Tier | Mechanism | Freshness | Standing cred | Status |
|---|---|---|---|---|
| **allowlist table** | local rows, filled by hand or a periodic pull (`syncGroupsToAllowlist`) | last successful sync; no hard expiry in the legacy helper | SA key | **shipped**, legacy sync ([`allowlist-store.md`](./done/allowlist-store.md), [`google-directory-sync.md`](./done/google-directory-sync.md)) |
| **group snapshots** | independent timestamped memberships, checked per request | strict 15-minute default max age; planned 5-minute sync | SA key (read-only role, no DWD by default) | **implemented library; OA rollout pending** ([snapshot policy]) |
| **SAML assertion** | groups in Google's signed assertion, per sign-in | sign-in time only; no ongoing permission revocation | **none** | deferred design |
| **SCIM receiver** | IdP pushes users/groups to us | live (on change) | none (IdP-authed) | not planned (heavier; Google's SCIM is oriented at provisioning *into* SaaS) |

## SAML Group Attributes

In the Workspace Admin console, a **custom SAML app** has an Attribute Mapping step with a **"Group membership"** mapping: you pick which groups map to a SAML attribute you name, and Google-as-IdP puts membership into the SAML response ([Google group mapping], checked 2026-11-09). This avoids a standing directory credential for sign-in-time attributes. The resulting app session still holds an observation that ages: removal after sign-in is not pushed to that session. An SP-side adapter consumes assertions; it would not undo OA's separate decision to operate an OIDC broker.

### Superseded No-Broker Rationale

The original rejection of an IdP proxy depended on not operating an IdP. That boundary no longer describes OA: `login.oa.dev` is implemented with `@open-athena/auth/provider`, Worker and D1. Central directory lookup is now an explicit rollout direction ([broker design]), not rejected architecture. A broker-issued groups claim would still be a login-time snapshot unless consumers enforce its original observation time and a freshness bound. The existing broker does not by itself establish central Groups distribution or fleet-wide group revocation.

## Shape (proposed)

A possible future adapter beside `adapters/oidc.ts` could resolve a SAML assertion to `(email, groups[])` and map that evidence into app scopes. The following is the historical proposal, not the implemented `/groups` API: today's `groupPolicy(store, { groups, maxAgeS })` consumes timestamped snapshots, not SAML assertions. A SAML evidence contract would need a separate design before implementation.

- **`adapters/saml.ts`** — SP-side SAML: build the AuthnRequest / redirect, receive the POST binding, **validate the assertion** (XML signature against Google's IdP cert, `Audience`/`Destination`, `NotBefore`/`NotOnOrAfter` with clock skew, and one-time `assertion ID` replay guard — the SAML analogues of the OIDC nonce/`aud`/`exp` checks already in `core/jwt.ts`). Extract `email` + the group attribute.
  - The hard, must-get-right parts are the signature validation and replay guard. Prefer a vetted XML-dsig verifier over hand-rolling; if none fits the WinterCG/no-Node-deps constraint of `core/`, the adapter (not `core/`) may carry the dependency, since adapters are already the place runtime-specific code lives.
- **`groupPolicy(groupToScopes)`** (`core/policy.ts`) — `EmailPolicy`-adjacent, but keyed on the assertion's groups rather than the email. Composes under `firstMatch` like the others. (Signature TBD: the policy layer is email→scopes today; groups→scopes needs the assertion's groups threaded to the policy, so this is the one real `core` change.)
- **Optional write-through to the allowlist store** — on a successful SAML sign-in, `replaceSource('saml:<group>', members)` is *not* applicable (we only see the one user, not the whole group), but a per-user `put` can cache "email → groups → scopes" so a subsequent non-SAML path (a script token) can still authorize. Decide during build whether that coupling earns its keep.

## Feasibility spike (2026-09-22) — verdict: buildable on Workers, don't hand-roll

A research spike answered the one gating question ("does XML-dsig verification run on CF Workers, or must the adapter be Node-only?"). **It runs on Workers today** — no Node-only fallback needed — but with two firm constraints.

**Do not hand-roll C14N/dsig.** The RSA is trivial on WebCrypto; the danger is exclusive-C14N canonicalization + signature plumbing, which has a long tail of correctness traps (namespace visibility, `InclusiveNamespaces` PrefixList, attribute ordering, whitespace, and *which* subtree the `<Reference>` actually covers vs. what the app reads). There is **no small audited standalone exc-C14N in JS** to lean on (the only one, `xml-c14n`, is ~12 years dead). And this is not hypothetical: **SAMLStorm (CVE-2025-29775 / -29774, Mar 2025)** was a signature-bypass via comment-node injection that hit `xml-crypto`, `@node-saml/node-saml`, `samlify`, `saml2-js` and `passport-saml` *simultaneously*. If the specialists shipped that bug, a from-scratch C14N is materially more dangerous.

**Recommended path — a `saml/` adapter on `xml-crypto` (≥6.1.x) + `@xmldom/xmldom`, gated on `nodejs_compat`:**
- Prefer *bare* `xml-crypto` over `samlify`/`@node-saml/node-saml` for the Google-narrow case (enveloped signature + exclusive C14N + RSA-SHA256 is its default happy path) — avoids `xml2js`, `xml-encryption`, and `samlify`'s native/WASM `node-xmllint` validator (a Workers hazard).
- `xml-crypto`'s needs (`node:crypto` RSA-SHA256 + SHA-256) are all in Cloudflare's "fully supported" `nodejs_compat` set; `@xmldom/xmldom` + `xpath` are dependency-free pure JS. Use the *scoped* `@xmldom/xmldom` (unscoped `xmldom` is deprecated w/ CVEs).
- **Structural cost, weigh it:** this is the library's **first runtime dependency** and its **first `nodejs_compat` requirement**. `core/` stays zero-dep and WinterCG-pure; the SAML adapter is explicitly the "carries deps + needs the compat flag" component, so it won't run on a runtime without `nodejs_compat` (fine — Workers/Pages is the target). No public precedent for this exact stack on Workers exists, so we own the `workerd`/miniflare integration testing, not just Node unit tests.

**The dsig discipline is the whole feature — the validations, not the parsing:**
1. Drive authorization **only** off `xml-crypto`'s `getSignedReferences()` — extract group attributes from the *signed subtree*, never from the raw parsed doc (this is the SAMLStorm defence).
2. **Pin the expected IdP cert**; never trust the assertion's own embedded `X509Certificate`/`KeyInfo`.
3. Enforce that the signature reference covers the `<Assertion>` we read, plus `Conditions`/`NotBefore`/`NotOnOrAfter`/`Audience`/`Destination`/`InResponseTo` and a one-time assertion-ID replay guard.
4. Ship a **SAMLStorm-style malicious-input regression fixture** (comment injection, response-vs-assertion signature confusion) from day one.

`groupPolicy(groupToScopes)` and the optional allowlist write-through are unchanged from the Shape section above.

## Why it's bounded, not scary

The proposed surface is one request out, one signed assertion back, with a fixed set of validations against a maintained verifier. The historical spike identified costs rather than eliminating them: XML-signature dependencies, `nodejs_compat`, per-app Workspace SAML configuration and ongoing security maintenance. Dependency versions and runtime feasibility must be revalidated if work resumes. The benefit would be signed group evidence at sign-in without a directory-reader credential, not continuous membership observation or ongoing session revocation.

## Trigger to build

A concrete consumer requirement for SAML interoperability or an organization that cannot authorize a directory reader could justify revisiting this deferred design. Faster ongoing revocation is not a reason to choose login-only SAML: an already-issued app session does not observe a subsequent group change, and a sign-in-time write-through alone cannot fix that. It would require fresh evidence, reauthentication, bounded sessions or another explicit revocation mechanism. OA's current path is the [snapshot policy] with per-request checks and a hard freshness bound; central rollout prerequisites and the admin request are in the [Groups setup draft]. No SAML implementation or configuration is authorized by this spec.

[broker design]: ./cross-service-sso.md
[snapshot policy]: ./group-snapshots.md
[Groups setup draft]: ../docs/group-authorization-setup.md
[Google group mapping]: https://knowledge.workspace.google.com/admin/apps/about-group-membership-mapping
