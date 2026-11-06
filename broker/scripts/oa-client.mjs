#!/usr/bin/env node
/**
 * The broker's app registry from a terminal: the same table as `/admin`, through
 * `wrangler d1 execute`. Holding the Cloudflare token is what authorizes this.
 * Run from anywhere, with the token in the environment (`direnv exec`):
 *
 *   oa-client.mjs list
 *   oa-client.mjs create oa-jobs --name 'Job descriptions' --callback https://jobs.oa.dev/auth/oa/callback | wrangler secret put OA_LOGIN_CLIENT_SECRET
 *   oa-client.mjs rotate oa-jobs | wrangler secret put OA_LOGIN_CLIENT_SECRET
 *   oa-client.mjs set-callbacks oa-jobs --callback https://jobs.oa.dev/auth/oa/callback
 *   oa-client.mjs disable oa-jobs
 *   oa-client.mjs enable oa-jobs
 *
 * `create` and `rotate` print the secret to stdout, for piping, and refuse a
 * terminal. `create --secret-hash <hash>` registers an app whose secret already
 * exists. `--local` uses the local dev database. Needs `pnpm build` at the root.
 */
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const DB = 'oa-login'
const REDIRECT_DOMAINS = ['oa.dev']
const brokerDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** A SQL string literal: wrangler's `--command` takes no bound parameters. */
export const lit = s => `'${String(s).replaceAll("'", "''")}'`

const event = (id, action, actor, at, detail = null) =>
  `INSERT INTO provider_client_events (client_id, action, actor, at, detail) VALUES (${lit(id)}, ${lit(action)}, ${lit(actor)}, ${at}, ${detail === null ? 'NULL' : lit(detail)})`

export const existsSql = id => `SELECT id FROM provider_clients WHERE id = ${lit(id)}`

export const listSql = 'SELECT id, name, redirect_uris, disabled_at FROM provider_clients ORDER BY id'

export const createSql = ({ id, name, secretHash, redirectUris }, actor, at) => {
  const uris = JSON.stringify(redirectUris)
  return [
    `INSERT INTO provider_clients (id, name, secret_hash, redirect_uris, created_at, created_by, updated_at, updated_by) VALUES (${lit(id)}, ${lit(name)}, ${lit(secretHash)}, ${lit(uris)}, ${at}, ${lit(actor)}, ${at}, ${lit(actor)})`,
    event(id, 'create', actor, at, uris),
  ].join('; ')
}

export const rotateSql = (id, secretHash, actor, at) =>
  [`UPDATE provider_clients SET secret_hash = ${lit(secretHash)}, updated_at = ${at}, updated_by = ${lit(actor)} WHERE id = ${lit(id)}`, event(id, 'rotate', actor, at)].join('; ')

export const setDisabledSql = (id, disabled, actor, at) =>
  [
    `UPDATE provider_clients SET disabled_at = ${disabled ? at : 'NULL'}, updated_at = ${at}, updated_by = ${lit(actor)} WHERE id = ${lit(id)}`,
    event(id, disabled ? 'disable' : 'enable', actor, at),
  ].join('; ')

export const setCallbacksSql = (id, redirectUris, actor, at) => {
  const uris = JSON.stringify(redirectUris)
  return [`UPDATE provider_clients SET redirect_uris = ${lit(uris)}, updated_at = ${at}, updated_by = ${lit(actor)} WHERE id = ${lit(id)}`, event(id, 'update', actor, at, uris)].join('; ')
}

function execute(sql, local) {
  const [cmd, where] = local ? ['npx', ['wrangler']] : [resolve(brokerDir, 'scripts/oa-wrangler.sh'), []]
  const args = [...where, 'd1', 'execute', DB, local ? '--local' : '--remote', '--json', '--command', sql]
  const r = spawnSync(cmd, args, { cwd: brokerDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, CI: '1' } })
  if (r.status !== 0) throw new Error(`wrangler failed: ${r.stdout}`)
  return JSON.parse(r.stdout)
}

const die = message => {
  console.error(message)
  process.exit(1)
}

async function main() {
  const { values: o, positionals: [command, id] } = parseArgs({
    allowPositionals: true,
    options: {
      callback: { type: 'string', multiple: true, default: [] },
      local: { type: 'boolean', default: false },
      name: { type: 'string' },
      'secret-hash': { type: 'string' },
    },
  })
  const { clientIdProblem, hashClientSecret, mintClientSecret, redirectUriProblem } = await import('../../dist/provider/index.js')
  const actor = `cli:${process.env.USER ?? 'unknown'}`
  const at = Math.floor(Date.now() / 1000)
  const run = sql => execute(sql, o.local)
  const exists = () => run(existsSql(id))[0].results.length > 0
  const callbacks = () => {
    if (!o.callback.length) die('--callback is required')
    for (const uri of o.callback) {
      const p = redirectUriProblem(uri, REDIRECT_DOMAINS)
      if (p) die(p)
    }
    return o.callback
  }
  const refuseTerminal = () => {
    if (process.stdout.isTTY) die('refusing to print a client secret to a terminal: pipe it into a secret store')
  }
  if (command === 'list') {
    for (const c of run(listSql)[0].results) console.log([c.id, c.disabled_at === null ? 'active' : 'disabled', c.name, ...JSON.parse(c.redirect_uris)].join('\t'))
    return
  }
  if (!id) die(`usage: oa-client.mjs list | {create,rotate,set-callbacks,disable,enable} <id>`)
  switch (command) {
    case 'create': {
      const idProblem = clientIdProblem(id)
      if (idProblem) die(idProblem)
      if (!o.name) die('--name is required')
      const redirectUris = callbacks()
      const given = o['secret-hash']
      if (!given) refuseTerminal()
      if (exists()) die(`${id} is taken`)
      const secret = given ? null : mintClientSecret()
      run(createSql({ id, name: o.name, secretHash: given ?? (await hashClientSecret(secret)), redirectUris }, actor, at))
      if (secret) process.stdout.write(secret)
      break
    }
    case 'rotate': {
      refuseTerminal()
      if (!exists()) die(`no client ${id}`)
      const secret = mintClientSecret()
      run(rotateSql(id, await hashClientSecret(secret), actor, at))
      process.stdout.write(secret)
      break
    }
    case 'set-callbacks': {
      const redirectUris = callbacks()
      if (!exists()) die(`no client ${id}`)
      run(setCallbacksSql(id, redirectUris, actor, at))
      break
    }
    case 'disable':
    case 'enable':
      if (!exists()) die(`no client ${id}`)
      run(setDisabledSql(id, command === 'disable', actor, at))
      break
    default:
      die(`unknown command: ${command}`)
  }
  console.error(`${command} ${id}: done`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
