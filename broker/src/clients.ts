/**
 * The apps that may sign people in through this broker. Adding one is a
 * reviewed change here: an id, `hashClientSecret(secret)` (the secret itself
 * goes only to that app), and its exact callback URLs.
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
]
