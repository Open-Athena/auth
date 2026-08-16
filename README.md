# `sherry`

> *share-y* — a small measure of access.
> Named share links, SSO, and an access log for gated dashboards.

Reusable auth layers for apps with the "public site, gate a slice" shape: a backend kernel (HMAC sessions + DB-backed grant tokens, an SSO IdP adapter) and source-agnostic React FE primitives (`useWhoami` / `AuthGate` / `SignInPanel` / `WhoamiChip`).

Mint a link, name it after the person you're sending it to, set how many times and how long it works, and see what they looked at. SSO for staff; request-access for everyone else.

Extraction target for the shipped implementations in [watchy] (Tier-2 reference), [marin-gcs-usage] (Tier 1), [mortgage-viz] (grants/nonce substrate), and applitrack (allowlist table).

- [`specs/sherry.md`](specs/sherry.md) — two-tier model, layer split, packaging
- [`specs/share-links-and-audit.md`](specs/share-links-and-audit.md) — share-link config, request-access, access log, analytics

The name is a silly diminutive — "share-y" — and a fount of iconography.

[watchy]: https://github.com/runsascoded/watchy
[marin-gcs-usage]: https://github.com/Open-Athena/marin-gcs-usage
[mortgage-viz]: https://github.com/runsascoded/mortgage-viz
