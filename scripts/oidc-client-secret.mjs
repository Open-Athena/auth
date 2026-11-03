#!/usr/bin/env node
/**
 * Mint a client secret for an app registered with `@open-athena/auth/provider`
 * (a broker's `clients` list), for piping straight into the app's secret store
 * so it is never shown. The hash, which is what the broker's config holds, goes
 * to stderr:
 *
 *   scripts/oidc-client-secret.mjs | broker/scripts/oa-wrangler.sh pages secret put OA_LOGIN_CLIENT_SECRET --project-name oa-gcs-usage --env preview
 *   # stderr: secretHash: '<hash>'   (into broker/src/clients.ts)
 *
 * Refuses to write to a terminal. Needs the package built (`pnpm build`).
 */
import { hashClientSecret } from '../dist/provider/index.js'

if (process.stdout.isTTY) {
  console.error('refusing to print a client secret to a terminal: pipe it into a secret store')
  process.exit(1)
}
const bytes = crypto.getRandomValues(new Uint8Array(32))
const secret = Buffer.from(bytes).toString('base64url')
process.stdout.write(secret)
console.error(`secretHash: '${await hashClientSecret(secret)}'`)
