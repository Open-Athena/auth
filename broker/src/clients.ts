/**
 * Apps registered in code, which win over the D1 registry on a clash. Most
 * belong in the registry (`/admin`, `scripts/oa-client.mjs`). This list is for
 * what the registry refuses, such as a callback outside `CLIENT_REDIRECT_DOMAIN`,
 * and adding one is a reviewed change: an id, `hashClientSecret(secret)` (the
 * secret itself goes only to that app), and its exact callback URLs.
 */
import type { ProviderClient } from '@open-athena/auth/provider'

export const clients: ProviderClient[] = []
