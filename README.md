# `cf-gate`

Reusable auth layers for Cloudflare-hosted apps with the "public site, gate a slice" shape: a backend package (HMAC sessions + DB-backed grant tokens, CF Access as SSO IdP) and source-agnostic React FE primitives (`useWhoami` / `AuthGate` / `SignInPanel` / `WhoamiChip`).

Extraction target for the shipped implementations in [watchy] (Tier-2 reference), [marin-gcs-usage] (Tier 1), [mortgage-viz] (grants/nonce substrate), and applitrack (allowlist table). See [`specs/cf-gate.md`](specs/cf-gate.md).

[watchy]: https://github.com/runsascoded/watchy
[marin-gcs-usage]: https://github.com/Open-Athena/marin-gcs-usage
[mortgage-viz]: https://github.com/runsascoded/mortgage-viz
