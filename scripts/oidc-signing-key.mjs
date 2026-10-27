#!/usr/bin/env node
/**
 * Print a new RS256 private JWK for `@open-athena/auth/provider` (the
 * `keys: [JSON.parse(env.OIDC_SIGNING_KEY)]` a broker reads), for piping
 * straight into a secret store so it is never shown:
 *
 *   scripts/oidc-signing-key.mjs | demo/scripts/oa-wrangler.sh pages secret put OIDC_SIGNING_KEY --project-name oa-auth-demo
 *
 * Refuses to write to a terminal. `--kid <id>` overrides the default `k<yyyymmdd>`.
 * Needs the package built (`pnpm build`).
 */
import { generateSigningKey } from '../dist/provider/index.js'

const args = process.argv.slice(2)
const i = args.indexOf('--kid')
const kid = i >= 0 ? args[i + 1] : undefined
if (i >= 0 && !kid) throw new Error('--kid needs a value')
if (process.stdout.isTTY) {
  console.error('refusing to print a private key to a terminal: pipe it into a secret store')
  process.exit(1)
}
process.stdout.write(JSON.stringify(await generateSigningKey(...(kid ? [kid] : []))))
