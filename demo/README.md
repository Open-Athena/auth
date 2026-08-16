# `@open-athena/auth` demo

A live Tier-2 deployment of the package: Cloudflare Pages + Functions + D1. Intended home: **auth.oa.dev**.

Three surfaces:

| Path | What it shows |
|---|---|
| `/` | The two tiers, and the walkthrough worth doing |
| `/dashboard` | The gated view: the wall (SSO + request-access), then a watermarked page carrying the "access is logged" disclosure |
| `/admin` | The console: mint named/capped/expiring links, watch their activity, revoke them |

## The walkthrough

1. Open `/admin`, click **Start a sandbox**.
2. Mint a link named after someone. Copy it — the raw token is shown exactly once, because only its SHA-256 is stored.
3. Open the link (a private window makes the point best, but the two cookies are independent so the same browser works).
4. Back in `/admin`, watch the redemption and the views appear.
5. **Revoke**, then reload the recipient window. The session dies on its next request, and lands on the request-access wall rather than a bare 403.

Step 5 is the load-bearing one: grant-backed sessions re-join their grant row on every request, so revocation is instant across every session a link ever minted.

## Two gates, one grants table

`functions/_lib/gates.ts` builds two gates over the same D1 store:

- **`viewGate`** (`oa_demo_view`) — guards the dashboard. Staff pass by SSO; everyone else needs a link.
- **`adminGate`** (`oa_demo_admin`) — guards the console.

Separate cookie names let one browser hold both roles at once. The shared store is what makes revocation in one visible to the other.

A sandbox identity gets `admin` but deliberately **not** `reports`, so a visitor playing admin still meets the wall on the dashboard and has to mint themselves a link. Everything the console reads or writes is filtered by `created_by`, so visitors can't see — or revoke — each other's links; another sandbox's grant id returns 404 rather than 403, so ids stay unconfirmed. The access-request queue needs a separate `requests` scope that only staff hold, since it contains strangers' email addresses.

## Local dev

```bash
pnpm install          # from the repo root
cd demo
pnpm dev              # builds the lib, applies migrations, serves on :4187
```

Open **http://localhost:4187** — that's `wrangler pages dev`, which serves the Functions and proxies the rest to Vite on `:4188`. Hitting 4188 directly gets you the frontend with no API.

With no `SESSION_SECRET` set, a fixed dev secret is used **only** for requests to localhost; a deployed instance without one fails loudly instead.

Migrations come straight from the package (`migrations_dir = "../migrations"`), so the demo can't drift from the schema it documents.

## Deploying

```bash
wrangler d1 create oa-auth-demo          # paste database_id into wrangler.toml
wrangler d1 migrations apply oa-auth-demo --remote
wrangler pages secret put SESSION_SECRET # openssl rand -base64 32
wrangler pages secret put ACCESS_AUD     # the Access application's AUD tag
pnpm deploy
```

Then, for SSO, create **one** Cloudflare Access application covering `auth.oa.dev/auth/sso` and nothing else. Narrowness is the point: the landing page and its og:image stay publicly crawlable so unfurls work, and Access is reduced to an IdP on a single path. Set `ACCESS_TEAM_DOMAIN` in `wrangler.toml` to your Zero Trust team domain.

Without that application configured, `/auth/sso` returns 401 and the SSO button is inert — everything else (share links, request-access, the log) still works.

## Caveats

- `notify` is a no-op: approving an access request prints the link in the console instead of emailing it. Wiring a transport is an app concern, which is the point of the hook.
- Sandbox data is never garbage-collected. A real deployment wants a retention job; see share-links-and-audit §4.
- `logViews` is **on** here because the access log is the thing being demonstrated. It defaults off in the package, and should be turned on together with the disclosure copy rather than silently.
