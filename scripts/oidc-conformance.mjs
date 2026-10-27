#!/usr/bin/env node
/**
 * Set up a run of the OpenID Foundation's hosted conformance suite
 * (https://www.certification.openid.net, Basic OP plan,
 * `oidcc-basic-certification-test-plan`, static client, client_secret_basic)
 * against a broker that registers its two test clients when
 * `OIDC_CONFORMANCE_SECRET` is set (the demo's `_lib/broker.ts`).
 *
 * Writes the plan's JSON config, secret included, to `--out` (reusing the
 * secret already there, so re-running is idempotent), and with `--run` stores
 * the secret on the Pages project via wrangler's stdin. The secret is never
 * printed: paste the config file into the suite's "JSON" tab yourself.
 * `--off` deletes the Pages secret (the clients vanish on the next deploy).
 *
 * Pages secrets take effect on the next deployment.
 *
 * Usage (from the repo root, with the OA Cloudflare token in the env):
 *   scripts/oidc-conformance.mjs --issuer https://auth.oa.dev --project oa-auth-demo [--run | --off]
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const args = process.argv.slice(2)
const opt = (name, dflt) => {
  const i = args.indexOf(name)
  if (i < 0) return dflt
  if (!args[i + 1]) throw new Error(`${name} needs a value`)
  return args[i + 1]
}
const issuer = opt('--issuer', 'https://auth.oa.dev').replace(/\/$/, '')
const project = opt('--project', 'oa-auth-demo')
const alias = opt('--alias', 'oa-auth-demo')
const out = opt('--out', 'tmp/oidc-conformance/config.json')
const wrangler = ['demo/scripts/oa-wrangler.sh', 'pages', 'secret']

if (args.includes('--off')) {
  execFileSync(wrangler[0], [...wrangler.slice(1), 'delete', 'OIDC_CONFORMANCE_SECRET', '--project-name', project], { stdio: ['pipe', 'inherit', 'inherit'], input: 'y\n' })
  process.exit(0)
}

const prior = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null
const secret = prior?.client?.client_secret ?? Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
const client = id => ({ client_id: id, client_secret: secret })
const config = {
  alias,
  description: `@open-athena/auth/provider at ${issuer}`,
  server: { discoveryUrl: `${issuer}/.well-known/openid-configuration` },
  client: client('oidf-conformance'),
  client2: client('oidf-conformance-2'),
}
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
console.error(`${prior ? 'kept' : 'new'} secret; config at ${out} (redirect URI: https://www.certification.openid.net/test/a/${alias}/callback)`)

if (args.includes('--run')) {
  execFileSync(wrangler[0], [...wrangler.slice(1), 'put', 'OIDC_CONFORMANCE_SECRET', '--project-name', project], { stdio: ['pipe', 'inherit', 'inherit'], input: secret })
}
