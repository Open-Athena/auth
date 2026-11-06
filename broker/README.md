# login.oa.dev

OA's sign-in broker: an OIDC provider ([`@open-athena/auth/provider`]) for OA's own apps, so signing in at one of them signs you in at the next with no page in between ([`specs/cross-service-sso.md`]).

- The only way in is Google, and only for Workspace accounts at `WORKSPACE_DOMAIN` (`openathena.ai`): the id_token's `hd` must match, so a consumer Google account using an OA address is refused.
- One person per browser. Choosing a different Google account is Google's own chooser: an app's `prompt=select_account` or `prompt=login` sends you through it.
- Apps are registered in D1, at [`/admin`](#registering-an-app) or with [`scripts/oa-client.mjs`]. No deploy needed.
- A Cloudflare Worker with its own D1 database (`oa-login`) and the `login.oa.dev` custom domain (`wrangler.toml`; deploying creates the DNS record).

## Routes

| Path | |
|---|---|
| `/.well-known/openid-configuration`, `/oidc/{authorize,token,userinfo,jwks,logout}` | The provider |
| `/signin?next=/oidc/authorize?…` | Where the provider sends someone to sign in: straight on to Google |
| `/signin/return?next=…` | Back from Google: on to `next`, or a page saying why not, with "Back to the app" (a `login_required` for it) |
| `/auth/google/{start,callback}` | The Google flow |
| `/admin` | Registered apps, for `ADMIN_EMAILS` only |
| `/` | Who's signed in here; sign out |

## Registering an app

At `/admin`, or from a terminal, which pipes the secret into the app without showing it:

```bash
direnv exec . scripts/oa-client.mjs create my-app --name 'My app' --callback https://my-app.oa.dev/auth/oa/callback \
  | wrangler secret put OA_LOGIN_CLIENT_SECRET   # in the app, with OA's Cloudflare token
```

`oa-client.mjs` also has `list`, `rotate`, `set-callbacks`, `disable` and `enable`. In the app, `OA_LOGIN_ISSUER` is `https://login.oa.dev`.

- Both accept only https callbacks under `CLIENT_REDIRECT_DOMAIN` (`oa.dev`), or loopback. Anything else goes in [`src/clients.ts`], which is a reviewed change. That limit is what stands between a stolen admin session and sending sign-ins somewhere else.
- `/admin` is for `ADMIN_EMAILS`. The CLI is for whoever holds the Cloudflare token.
- Disabling takes effect on the app's next request. Rotating breaks sign-in until the app has the new secret.
- Every change is logged and shown at `/admin`. Clients are disabled rather than deleted.

## Local dev

```bash
printf 'DEV_SIGNIN=1\n' > .dev.vars   # a sign-in form standing in for Google, loopback only
pnpm dev                              # http://localhost:4191
```

`DEV_SIGNIN` also registers a `dev-rp` client (secret `dev-rp-secret`, callback `http://localhost:4191/dev/callback`) to drive the flow by hand. The issuer is always `http://localhost:4191` locally (`--local-upstream`), so use that host rather than a tailnet name.

## Provisioning

From this directory, with the OA Cloudflare token in the environment (`direnv exec .`):

```bash
scripts/oa-wrangler.sh d1 create oa-login     # then put its id in wrangler.toml
pnpm db:remote
openssl rand -base64 32 | tr -d '\n' | scripts/oa-wrangler.sh secret put SESSION_SECRET
../scripts/oidc-signing-key.mjs | scripts/oa-wrangler.sh secret put OIDC_SIGNING_KEY
scripts/oa-wrangler.sh secret put GOOGLE_CLIENT_ID
scripts/oa-wrangler.sh secret put GOOGLE_CLIENT_SECRET
pnpm deploy
```

The Google client is a "Web application" OAuth client in an OA GCP project, with redirect URI `https://login.oa.dev/auth/google/callback` (`../scripts/provision-oauth-client.mjs` walks the console step). Its consent screen should be "Internal" to the Workspace.

[`@open-athena/auth/provider`]: ../specs/oidc-provider.md
[`specs/cross-service-sso.md`]: ../specs/cross-service-sso.md
[`src/clients.ts`]: src/clients.ts
[`scripts/oa-client.mjs`]: scripts/oa-client.mjs
