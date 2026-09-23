# Groups, live from the directory: a SAML adapter

*(RW + session, 2026-09-22. From the hccs-funds thread — "there must be a blessed way for apps to OAuth against Google with awareness of user groups?" — and the analysis that followed. This is the "real groups" tier: membership arrives signed, at each sign-in, with no standing directory credential and no out-of-band snapshot. **Not yet built** — a claimed design, to build when a consumer needs live directory groups. HCCS's twice-a-year board does not; [`allowlist-store.md`](./done/allowlist-store.md) covers it.)*

## The load-bearing fact

Google's OIDC id_token **never carries Workspace group membership** — by design. "Sign in with Google" (`accounts.google.com`) returns `email`, `hd`, `name`, `picture`, `sub`, and nothing about groups. This is a Google-specific gap, not a gap in OIDC: enterprise IdPs (Okta, Entra, Auth0, Keycloak) *do* emit a `groups` claim when configured. Google just doesn't, over OIDC.

So any group-awareness requires a directory lookup *somewhere*. The question is only where and when. Three honest tiers, by how "in-band" the membership is:

| Tier | Mechanism | Freshness | Standing cred | Status |
|---|---|---|---|---|
| **allowlist table** | local rows, filled by hand or a periodic pull (`syncGroupsToAllowlist`) | sync interval | SA key (read-only group access, no DWD) | **shipped** ([`allowlist-store.md`](./done/allowlist-store.md), [`google-directory-sync.md`](./done/google-directory-sync.md)) |
| **SAML assertion** | groups in Google's signed assertion, per sign-in | live | **none** | this spec |
| **SCIM receiver** | IdP pushes users/groups to us | live (on change) | none (IdP-authed) | not planned (heavier; Google's SCIM is oriented at provisioning *into* SaaS) |

## Why SAML is the "blessed" one

In the Workspace Admin console, a **custom SAML app** has an Attribute Mapping step with a **"Group membership"** mapping: you pick which groups map to a SAML attribute you name, and Google-as-IdP then puts the user's membership **into the signed assertion at each sign-in**. No standing directory credential, no snapshot to age out — the membership is signed by Google, fresh, in the assertion. This is exactly how enterprises wire Google → third-party SaaS for group-based access, and it keeps us a **relying party** (we consume an assertion) rather than an IdP.

### The path we explicitly reject

An **IdP proxy** (Dex, Keycloak, Pomerium) logs in via Google OIDC, does the Directory lookup once, and re-issues an OIDC token *with* a groups claim. Real and standard-ish — Dex's Google connector does exactly this — but it means **becoming an IdP**, which [`sessions-resources-idp.md`](./sessions-resources-idp.md) ("…and not becoming an IdP") rules out. It relocates the credential and complexity into a stateful service we'd run. The SAML adapter gets the same result (groups at sign-in) while we stay a relying party.

## Shape (proposed)

A new adapter beside `adapters/oidc.ts`, feeding the *same* scope-mapping `policy` seam — a SAML assertion resolves to `(email, groups[])`, and a `groupPolicy(map)` turns groups into scopes, exactly parallel to how `oidcCallback` resolves `(email)` and `policy` turns it into scopes.

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

Narrow surface: one request out, one signed assertion back, a fixed set of validations against a maintained, patched verifier. The costs are real but known — a first dependency + `nodejs_compat`, per-app SAML-app setup in the Workspace console (heavier than "create an OAuth client"), and ongoing patch vigilance on a dep tree with a repeated-CVE history. In exchange it's the one mechanism that makes the library genuinely *aware of upstream Google groups without a snapshot*, so it's a claimed, now-de-risked tier — not the "too hard" bucket, but also not free.

## Trigger to build

A consumer that needs **live** directory-group membership (a group that changes often enough that the allowlist-table sync's staleness window matters, or an org that won't grant even a scheduled Directory read scope). Until then, `allowlist-store.md` + the package's `syncGroupsToAllowlist` cron ([`google-directory-sync.md`](./done/google-directory-sync.md)) is the right-sized answer, and this stays a design. Note the revocation math: this adapter refreshes groups only at sign-in, so it is *slower* to revoke than a 15-minute sync unless it also writes into the allowlist table. The spike above means that when the trigger comes, the path is concrete and the risks are named — not that we build it speculatively now.
