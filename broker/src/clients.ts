/**
 * Apps registered in code, which win over the D1 registry on a clash. Most
 * belong in the registry (`/admin`, `scripts/oa-client.mjs`). This list is for
 * what the registry refuses, such as a callback outside `CLIENT_REDIRECT_DOMAIN`,
 * and adding one is a reviewed change: an id, `hashClientSecret(secret)` (the
 * secret itself goes only to that app), and its exact callback URLs.
 */
import type { ProviderClient } from '@open-athena/auth/provider'

export const clients: ProviderClient[] = [
  // disky's dev.gcs.oa.dev (`oa-gcs-usage` Pages project, preview env;
  // `OA_LOGIN_CLIENT_SECRET` there). ~/c/disky/wt/gcs/specs/oa-login-rp.md.
  {
    id: 'disky-gcs-dev',
    secretHash: 'GU57XIzT1CEZ5769SCQDmkdTBYQpY9ObMPGqwZ3PoUA',
    redirectUris: ['https://dev.gcs.oa.dev/auth/oa/callback'],
  },
  // jobs.oa.dev (`oa-jobs` Worker; `OA_LOGIN_CLIENT_SECRET` there). ~/c/oa/jobs.
  {
    id: 'oa-jobs',
    secretHash: '5NgqObLwulfo8TPH0_DPSqmiGYyjrQXHwiK3OHxZ6S8',
    redirectUris: ['https://jobs.oa.dev/auth/oa/callback'],
  },
]
