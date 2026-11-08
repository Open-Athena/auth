# Scoped Client Management

Requested by Disky in Agent Mail message 232 and authorized to start by Ryan in auth on 2026-11-07. Status: implemented and tested; hosted API activation and MCP wrapper remain separate rollout work. This is an operator API, not open dynamic client registration. Production deployment and minting new management credentials remain explicit rollout steps.

## Contract

Expose `clientManagementRoutes` and `managementTokenAuth` from `/provider`. The broker optionally mounts `/api/clients` only when operator-configured management grants exist. A grant has a server-set audit actor, hashed high-entropy bearer token, mandatory expiration, allowed operations, and exact per-client callback/logout URL allowlists. No wildcard client or callback authority, cookie authentication, management-token minting endpoint, or implicit admin grant. Registry/domain validation still applies. Static clients cannot be managed through this endpoint. Mutation requests with a browser Origin are refused.

`GET /api/clients` lists only scoped clients; `GET /:id` inspects one. `PUT /:id` creates with caller-supplied SHA-256/base64url `secretHash`, name and callback lists; matching retries return the existing row without mutation, mismatches return 409. `PATCH /:id` updates name and callback lists within the capability. `POST /:id/disable`, `/enable` and `/rotate` are separate permissions. Rotation requires `expectedSecretHash` and the replacement hash, uses atomic compare-and-swap plus audit, and never silently rotates on create. A matching already-completed rotation is a no-op. Metadata responses exclude hashes; plaintext client secrets never enter this API. Bodies and list sizes are bounded; failures do not echo supplied credentials.

## Secret Ownership and Recovery

The caller generates and retains the secret in its approved secret store before registration, and sends only its hash. The broker cannot lose an undisplayed server-generated secret because it generates none. For the initial Disky handoff, a reusable Pages provisioning CLI installs the in-memory secret first, records a nonsecret recovery receipt (hash/config/destination/phase), and registers the client second. It refuses to overwrite any existing destination secret. Registration failure can resume using the installed receipt without touching the destination. An ambiguous interruption during destination installation fails closed for operator reconciliation. The two external services cannot be made one transaction; do not advertise exactly-once provisioning or recoverability without the receipt.

MCP, if added later, is only a thin wrapper around the same authorized HTTP operations. It must never return generated secrets in model-visible output. The HTTP API and CLI are useful independently, so an MCP server is not a prerequisite.

## Acceptance

Test authentication and exact expiry before any storage/body read; expired/missing/forged grants, malformed config, static/out-of-scope IDs, callback widening, method/media/body bounds, secret-free responses, audit attribution, matching and conflicting create retries, explicit rotation and stale CAS, and feature-disabled broker behavior. Exercise real registry SQL. No new management-token issuance, production deployment or callback-policy relaxation is implied by implementation.

## Implementation and Verification

`clientManagementRoutes` and `managementTokenAuth` are exported from `/provider`, with optional broker wiring at `/api/clients`. Hash-only expiring capabilities cover exact client IDs, URLs and actions; cookies grant nothing. D1 implements optional `rotateIfCurrent` and `setDisabledIfChanged` operations with conditional audit insertion in the same transaction. Custom adapters without an atomic operation receive 501 rather than an unsafe fallback. Serial metadata retries avoid extra writes; concurrent metadata edits remain last-write-wins.

The 110 focused tests cover API authorization/validation, real-SQL CAS/audit and CLI failure/recovery. A review found non-string hash coercion and duplicate concurrent disable audit; both were reproduced with failing tests and fixed. Removing expiry, exact-client scope, create-hash comparison or SQL CAS guards made the corresponding regression tests fail; all mutations were restored. Full suite: 1,254 passed, two skipped; local workerd/D1 retained tests: 118 passed. Root typecheck/build and broker typecheck passed. See `docs/client-management.md` for the usable contract.

After explicit direct user approval, the operator bootstrap created `oa-disky` with the production callback `https://disky.oa.dev/auth/oa/callback` and `oa-disky-dev` with `https://dev.disky.oa.dev/auth/oa/callback` plus `http://localhost:3871/auth/oa/callback`. Distinct generated secrets were installed directly as `OA_LOGIN_CLIENT_SECRET` in Pages `disky-oa` production/preview, respectively. Metadata and audit read-back passed; no plaintext was printed or saved locally. Recovery receipts contain only hashes/configuration/phases and variable names/types. No existing value was overwritten, no DNS changed, and neither application nor broker code was deployed. The management API itself remains disabled until an operator configures grants and deploys it; this provisioning used the existing operator path, not an unshipped endpoint. Disky received the separate completion handoff.
