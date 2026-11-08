# Agent-Facing Client Management

The optional `/provider` management API lets an operator delegate registration for specific apps without handing an agent a Cloudflare token, D1 access, browser admin session, or global broker administration. It is not public OIDC dynamic registration. Library source and tests implement this interface; enabling a hosted broker and issuing management capabilities are separate operator actions.

## Minimal Wiring

```ts
import { clientManagementRoutes, managementTokenAuth } from '@open-athena/auth/provider'
import { d1ClientRegistry } from '@open-athena/auth/provider/d1'

const routes = clientManagementRoutes({
  registry: d1ClientRegistry(env.DB),
  redirectDomains: ['example.org'],
  reservedClientIds: staticClients.map(c => c.id),
  authorize: managementTokenAuth(JSON.parse(env.CLIENT_MANAGEMENT_GRANTS)),
})
// Return await routes(request), or fall through when it returns null.
```

The reference broker mounts `/api/clients` only when `CLIENT_MANAGEMENT_GRANTS` is configured. Missing configuration returns 404; invalid configuration returns 503 without echoing it. No configuration or capability was installed in production as part of implementing this API.

Each grant has this shape. The operator hashes a newly generated high-entropy bearer token with `hashClientSecret`; the bearer goes directly into the intended agent's approved credential store, not model-visible output. The JSON below is schematic, not a usable grant:

```json
{
  "actor": "agent:app-registration",
  "tokenHash": "<SHA-256, base64url without padding>",
  "expiresAt": 1800000000,
  "actions": ["read", "create"],
  "clients": {
    "example-app": {
      "redirectUris": ["https://app.example.org/auth/oa/callback"],
      "postLogoutRedirectUris": ["https://app.example.org/"]
    }
  }
}
```

The broker setting is an array of grants. Expiration is epoch seconds and is enforced at the exact deadline. There are no wildcard app IDs or callbacks. An absent action means no permission. Grant callback lists cap what the caller can register; the deployment's domain/loopback validation is enforced independently. Keep prod/dev clients and capabilities separate. Possession of a grant authorizes its explicitly delegated operations; arbitrary approval headers do not prove human consent. Issue only the authority the user actually approved, with the shortest practical expiry, and remove its hash to revoke it. Capabilities cannot mint more capabilities through this API.

## HTTP Contract

Use HTTPS and `Authorization: Bearer <management-token>`, supplied by a tool/process from its credential store. The client secret used for OIDC is a different credential and grants no management access. Browser cookies do not authenticate this API; writes with an Origin header are refused. Mutations require JSON; request bodies cap at 64 KiB, callback lists at 20 entries each, and unknown fields are rejected. Responses are `no-store` and never include secret hashes or plaintext secrets.

| Request | Body | Permission |
| --- | --- | --- |
| `GET /api/clients` | None | `read`, filtered to scoped IDs |
| `GET /api/clients/:id` | None | `read` |
| `PUT /api/clients/:id` | `{name, secretHash, redirectUris, postLogoutRedirectUris?}` | `create` |
| `PATCH /api/clients/:id` | `{name, redirectUris, postLogoutRedirectUris?}` | `update` |
| `POST /api/clients/:id/disable` | `{}` | `disable` |
| `POST /api/clients/:id/enable` | `{}` | `enable` |
| `POST /api/clients/:id/rotate` | `{expectedSecretHash, secretHash}` | `rotate` |

Metadata operations return `{client, changed}`; GET detail returns `{client}` and GET list returns `{clients}`. Creation returns 201, a matching retry 200 with `changed:false`. A different hash or configuration for an existing ID returns 409, never rotation or callback replacement. Callback order is immaterial to matching. Create retries do not enable a disabled client. Metadata PATCH supplies the whole metadata configuration and uses last-write-wins semantics; it does not replace the secret. Unknown/out-of-scope/static IDs return 404 rather than confirming their existence.

Rotation requires the expected old hash and uses the registry's optional `rotateIfCurrent` atomic operation with its audit row. Disable/enable use `setDisabledIfChanged` so concurrent duplicate requests record one transition. D1 implements both; custom stores without the required atomic operation receive 501, never a read-then-write fallback. A matching replacement already installed at the broker is a no-op; otherwise a stale expected hash returns 409. Registry audit events use the server-configured actor and never put hashes or tokens in detail. Serial metadata retries avoid extra events; concurrent metadata updates remain last-write-wins, not an exactly-once workflow.

## Secret Delivery and Interrupted Provisioning

The API deliberately accepts a hash rather than generating a one-shot secret in an HTTP response. Generate the client secret outside model-visible output, retain it at an approved destination, persist its hash and desired configuration as a nonsecret recovery receipt, then register the hash. Retrying the same receipt does not rotate an existing credential. Losing a caller-held plaintext secret before storing it must not cause an automatic rotation; explicit recovery approval is required. Protect receipts against edits: although they contain no plaintext secret, they govern recovery decisions.

The reference bootstrap tool `broker/scripts/provision-pages-client.mjs`, run from a built source checkout, implements this order for Cloudflare Pages while the new HTTP endpoint is not yet deployed. It needs the existing operator credential and is not the delegated API client. Dry-run reads only; `--run` is explicit. For each distinct environment, use a distinct receipt and client ID:

```bash
direnv exec . node broker/scripts/provision-pages-client.mjs \
  --id example-app --name 'Example app' \
  --callback https://app.oa.dev/auth/oa/callback \
  --account-id <account-id> --database-id <broker-d1-id> \
  --pages-project example-app --environment production \
  --receipt tmp/example-app-provision.json
# Add --run only after reviewing the dry run and approving these destinations.
```

The helper keeps the plaintext only in memory and sends it to the selected `OA_LOGIN_CLIENT_SECRET` environment before registering the hash. It does not deploy the app, change DNS, create Google OAuth clients, or replace existing secrets. Keep the nonsecret receipt for retries. A failure after confirmed installation resumes registration without reinstalling. An interruption between sending and confirming a Pages write is ambiguous because Pages does not return an existing secret's value; the tool refuses an automatic retry or overwrite and requires operator reconciliation. D1 and Pages are not one transaction. Serialize external writers to the same secret destination; a local receipt lock cannot prevent unrelated Cloudflare writers.

## MCP Boundary

A future MCP wrapper can expose these same operations and carry the management bearer outside tool arguments/history. It must retain all callback/action checks, give the user a nonsecret mutation plan, and return only metadata/results. It must not expose a generic SQL/Cloudflare proxy or return generated credentials to the model. HTTP support does not require hosting an MCP server; the wrapper is not implemented yet.
