# Client registry and admin at login.oa.dev

**Status:** in progress.

Adding an app to the broker takes a secret, an edit to `broker/src/clients.ts`, a commit, a broker deploy, and piping the secret into the app. The user asked for an admin dash instead (the need surfaced with `jobs.oa.dev`).

## Decisions

- **Registry in D1**: `provider_clients` (`migrations/provider/0002_clients.sql`), with every change logged in `provider_client_events`. Adding, disabling or rotating a client needs no deploy. Disabling takes effect on the next request: `/authorize`, `/token` and `/userinfo` all look the client up.
- **`oidcProviderRoutes` gains `lookupClient`**, alongside the static `clients` list, which still wins on a clash. The demo keeps its static list. The broker's list becomes empty once its clients have moved.
- **`login.oa.dev/admin`**: list, create, edit callbacks, disable/enable, rotate. Only `ADMIN_EMAILS`, not all of Workspace. A secret is shown once, in the response to the POST that made it.
- **CLI, `broker/scripts/oa-client.mjs`**: the same operations against the same table, through `wrangler d1 execute`. The secret goes to stdout and it refuses a terminal, so it can be piped into `wrangler secret put` without being shown. Agents use this, since they can't sign in to the dash.
- **Callback rule**: the dash and CLI accept only https under `CLIENT_REDIRECT_DOMAIN` (`oa.dev`) or loopback, already in normal form. Anything else needs the static list, which is a reviewed change. This limits what a compromised admin session can do, which is the cost of giving up review on every client.
- **No `dev.login.oa.dev`**: the user said nothing live depends on the current clients (`dev.gcs.oa.dev` is unused), so this ships directly to login.oa.dev.

## Not doing

- Overlapping secrets during rotation: an app fails sign-in between the rotate and its `wrangler secret put`. No app is busy enough yet to justify it.
- Deleting clients: disabled rows stay, for the log and so an id can't be silently reused.
