# login.oa.dev

OA's sign-in broker: an OIDC provider ([`@open-athena/auth/provider`]) for OA's own apps, so signing in at one of them signs you in at the next with no page in between ([`specs/cross-service-sso.md`]).

- The only way in is Google, and only for Workspace accounts at `WORKSPACE_DOMAIN` (`openathena.ai`): the id_token's `hd` must match, so a consumer Google account using an OA address is refused.
- One person per browser. Choosing a different Google account is Google's own chooser: an app's `prompt=select_account` or `prompt=login` sends you through it.
- Apps are registered in [`src/clients.ts`]: an id, `hashClientSecret(secret)`, exact callback URLs. Adding one is a reviewed change.
- A Cloudflare Worker with its own D1 database (`oa-login`) and the `login.oa.dev` custom domain (`wrangler.toml`; deploying creates the DNS record).

## Routes

| Path | |
|---|---|
| `/.well-known/openid-configuration`, `/oidc/{authorize,token,userinfo,jwks,logout}` | The provider |
| `/signin?next=/oidc/authorize?…` | Where the provider sends someone to sign in: straight on to Google |
| `/signin/return?next=…` | Back from Google: on to `next`, or a page saying why not, with "Back to the app" (a `login_required` for it) |
| `/auth/google/{start,callback}` | The Google flow |
| `/` | Who's signed in here; sign out |

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
