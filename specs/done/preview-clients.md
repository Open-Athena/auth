# PR-preview clients on the broker

Requested by the disky session; Ryan approved the contract on 2026-11-11 ("1. yes redesign sg go", in disky's `specs/open-questions.md` #1).

## Goal
PR previews at Cloudflare Pages branch hosts, `pr-N.<project>.pages.dev`, sign in through login.oa.dev with viewers' real roles, with one client registration per Pages project rather than one per branch.

## Contract (as built)
1. **A separate preview client per project.**
   - It has its own id, so ID tokens carry `aud: <preview client id>` and can't be replayed to the production app.
   - Its own secret lives only in the Pages project's Preview environment.
   - `ProviderClient.preview` / `RegisteredClient.preview`, stored as a row in `provider_preview_clients` (`migrations/provider/0004_preview_clients.sql`).
   - The flag is fixed at creation. `/admin` never flips it, and a taken id never becomes one.
2. **A one-label pattern** (`src/provider/redirects.ts`).
   - `https://*.<suffix>/<path>` admits `https://<label>.<suffix>/<path>`, where `<label>` is one DNS label.
   - The URL must be in normal form, with no port, query, fragment or userinfo, and the same path.
   - The pattern applies only on preview clients, for callbacks and post-logout URIs. A pattern string never matches itself exactly.
   - `/token` still compares the concrete URI exactly.
   - Registration (`redirectUriProblem(..., { previewSuffixes })`) accepts a pattern only for a suffix on the deployment's allowlist: the broker's `PREVIEW_HOST_SUFFIXES` var. Adding a host is a reviewed deploy.
   - The CLI and the management API pass no allowlist, so they refuse patterns.
3. **One click instead of silent sign-in.**
   - For a preview client, `/authorize` shows a page naming the host and account.
   - The page sets `frame-ancestors 'none'`, `X-Frame-Options: DENY`, and a `form-action` limited to self and the preview's origin.
   - The page POSTs back to the same `/authorize` URL. The POST is accepted only from the broker's own Origin and only for preview clients.
   - Every authorize check is re-run on the POST.
   - Allow stores `{sub, client, host, expiry}` in an HMAC-signed `__Host-oa_preview_ok` cookie for 7 days, at most 20 entries. Deny returns `access_denied`.
   - Until a consent exists, `prompt=none` gets `interaction_required`.
4. **No per-branch registration.**

## Relying party
- `OidcOptions.redirectUri` may be a function of the request.
- `redirectFromOrigin(path)` builds it from the request's origin.
- Deciding which hosts are previews, and using the preview client there, is the app's job.

## Tests
- `test/provider-redirects.test.ts`: the matcher and the registration rule.
- `test/provider.test.ts` "PR-preview clients":
  - one click per host, then silent;
  - the 7-day expiry and binding to the account;
  - cancel;
  - refusals: cross-site or no Origin, a bad decision, a forged cookie, a POST for a non-preview client;
  - the `aud`, and logout by pattern;
  - an exact-match client never matching a pattern.
- `broker/test/admin.test.ts`: creating a preview client, the allowlist, the fixed flag, and no preview clients without an allowlist.
