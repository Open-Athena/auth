# Groups, live from the directory: a SAML adapter

*(RW + session, 2026-09-22. From the hccs-funds thread — "there must be a blessed way for apps to OAuth against Google with awareness of user groups?" — and the analysis that followed. This is the "real groups" tier: membership arrives signed, at each sign-in, with no standing directory credential and no out-of-band snapshot. **Not yet built** — a claimed design, to build when a consumer needs live directory groups. HCCS's twice-a-year board does not; [`allowlist-store.md`](./done/allowlist-store.md) covers it.)*

## The load-bearing fact

Google's OIDC id_token **never carries Workspace group membership** — by design. "Sign in with Google" (`accounts.google.com`) returns `email`, `hd`, `name`, `picture`, `sub`, and nothing about groups. This is a Google-specific gap, not a gap in OIDC: enterprise IdPs (Okta, Entra, Auth0, Keycloak) *do* emit a `groups` claim when configured. Google just doesn't, over OIDC.

So any group-awareness requires a directory lookup *somewhere*. The question is only where and when. Three honest tiers, by how "in-band" the membership is:

| Tier | Mechanism | Freshness | Standing cred | Status |
|---|---|---|---|---|
| **allowlist table** | local rows, filled by hand or a pull | as fresh as the fill | none | **shipped** ([`allowlist-store.md`](./done/allowlist-store.md)) |
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

## Why it's bounded, not scary

It's a well-understood problem with a narrow surface: one request out, one signed assertion back, a fixed set of validations. The cost is that SAML setup is per-app admin-console config (create the custom SAML app, map the group attribute) — heavier than OIDC's "create an OAuth client" — and XML-dsig is fiddlier than JWT verification. But it's the mechanism that makes the library genuinely *aware of upstream Google groups without a snapshot*, so it belongs on the roadmap as a claimed tier, not in the "too hard" bucket.

## Trigger to build

A consumer that needs **live** directory-group membership (a group that changes often enough that the allowlist-table sync's staleness window matters, or an org that won't grant even a scheduled Directory read scope). Until then, `allowlist-store.md` + a periodic `replaceSource` sync is the right-sized answer, and this stays a design.
