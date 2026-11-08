#!/usr/bin/env node
/**
 * Install a new broker credential directly into Pages, then register its hash.
 * Dry-run is the default (remote reads only). Requires `pnpm build` at root.
 * Credentials come ONLY from CLOUDFLARE_ADMIN_TOKEN, never credential files.
 *
 * --id oa-app --name App --callback https://app.oa.dev/auth/oa/callback
 * --account-id <account> --database-id <uuid> --pages-project app
 * --environment production|preview [--run --receipt <nonsecret.json>]
 *
 * Keep the receipt; never edit its phase to resolve an ambiguous installation.
 * A stale <receipt>.lock requires operator review, not automatic takeover.
 * Serialize provisioning with other writers to this destination: Pages has no
 * documented create-only/CAS secret API, and D1 and Pages cannot commit together.
 *
 * Pages PATCH shape matches Wrangler 4.157.0's pagesSecretPutCommand, including
 * wrangler_config_hash. Omitted keys/environments are preserved (no read/spread
 * of other variables, whose secret values cannot be recovered):
 * https://developers.cloudflare.com/api/resources/pages/subresources/projects/methods/edit/
 * D1 accepts semicolon-separated SQL as a batch, like `oa-client create`:
 * https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/
 */
import { constants } from 'node:fs'
import { open, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { parseArgs } from 'node:util'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createSql } from './oa-client.mjs'

const SECRET_NAME = 'OA_LOGIN_CLIENT_SECRET'
const ACTOR = 'cli:provision-pages-client'
const API = 'https://api.cloudflare.com/client/v4'
const CLIENT_SQL = 'SELECT id, name, secret_hash, redirect_uris, post_logout_redirect_uris, disabled_at, created_at, created_by, updated_at, updated_by FROM provider_clients WHERE id = ?'
const AUDIT_SQL = 'SELECT client_id, action, actor, at, detail FROM provider_client_events WHERE client_id = ? ORDER BY id'
const PHASES = ['prepared', 'installing', 'installed', 'registered']
const ENVIRONMENTS = ['production', 'preview']

export class ProvisionError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ProvisionError'
    this.code = code
  }
}

const fail = (code, message) => { throw new ProvisionError(code, message) }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const keysAre = (value, keys) => object(value) && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort())
const digest = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value) && Buffer.from(value, 'base64url').toString('base64url') === value

export function parseOptions(args) {
  let values
  try {
    ;({ values } = parseArgs({
      args,
      options: {
        id: { type: 'string' },
        name: { type: 'string' },
        callback: { type: 'string', multiple: true, default: [] },
        'account-id': { type: 'string' },
        'database-id': { type: 'string' },
        'pages-project': { type: 'string' },
        environment: { type: 'string' },
        receipt: { type: 'string' },
        run: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
    }))
  } catch {
    fail('usage', 'Invalid arguments; use --help. Argument values are not echoed.')
  }
  return values
}

async function readReceipt(path) {
  if (!path) return null
  let file
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > 65536) fail('receipt_invalid', 'Receipt must be a small regular JSON file.')
    const receipt = JSON.parse(await file.readFile('utf8'))
    if (!object(receipt)) fail('receipt_invalid', 'Receipt must be a JSON object.')
    return receipt
  } catch (error) {
    if (error.code === 'ENOENT') return null
    fail('receipt_invalid', 'Cannot read a valid non-secret receipt; details suppressed.')
  } finally {
    await file?.close()
  }
}

// Flush before any remote write. Atomic replacement leaves either the previous
// phase or the next phase readable after an interruption, never truncated JSON.
async function writeReceipt(path, receipt, initial = false) {
  const temp = initial ? path : `${path}.${randomUUID()}.tmp`
  let file
  let created = false
  try {
    file = await open(temp, 'wx', 0o600)
    created = true
    await file.writeFile(`${JSON.stringify(receipt, null, 2)}\n`)
    await file.sync()
    await file.close()
    file = null
    if (!initial) await rename(temp, path)
    const directory = await open(dirname(resolve(path)), 'r')
    try { await directory.sync() } finally { await directory.close() }
  } finally {
    await file?.close()
    if (!initial && created) await unlink(temp).catch(error => {
      if (error.code !== 'ENOENT') throw error
    })
  }
}

function checkReceipt(receipt, client, destination) {
  if (!keysAre(receipt, ['version', 'client', 'destination', 'secretHash', 'actor', 'at', 'phase', 'pagesVariables']) ||
      receipt.version !== 1 || !PHASES.includes(receipt.phase) || !digest(receipt.secretHash) ||
      receipt.actor !== ACTOR || !Number.isSafeInteger(receipt.at) || receipt.at < 0 ||
      !validVariables(receipt.pagesVariables) ||
      receipt.pagesVariables[destination.environment].some(v => v.name === SECRET_NAME) ||
      !isDeepStrictEqual(receipt.client, client) || !isDeepStrictEqual(receipt.destination, destination)) {
    fail('receipt_mismatch', 'Receipt does not exactly match this operation; nothing will be overwritten.')
  }
}

const sortedVariables = variables => [...variables].sort((a, b) => a.name.localeCompare(b.name, 'en'))

function validVariables(variables) {
  return keysAre(variables, ENVIRONMENTS) && ENVIRONMENTS.every(env =>
    Array.isArray(variables[env]) && variables[env].every(v =>
      keysAre(v, ['name', 'type']) && typeof v.name === 'string' &&
      ['plain_text', 'secret_text', null].includes(v.type),
    ) && new Set(variables[env].map(v => v.name)).size === variables[env].length &&
    isDeepStrictEqual(variables[env], sortedVariables(variables[env])),
  )
}

// Only names/types cross the receipt boundary. Never copy variable values,
// including plaintext values, into a receipt, summary, or error message.
function pagesState(project, destination) {
  if (project?.name !== destination.pagesProject || !object(project.deployment_configs)) {
    fail('pages_metadata_invalid', 'Pages environment metadata is incomplete; nothing will be overwritten.')
  }
  const variables = {}
  for (const env of ENVIRONMENTS) {
    const config = project.deployment_configs[env]
    if (!object(config) || !Object.hasOwn(config, 'env_vars') ||
        (config.env_vars !== null && !object(config.env_vars)) ||
        (config.wrangler_config_hash != null && typeof config.wrangler_config_hash !== 'string')) {
      fail('pages_metadata_invalid', 'Pages environment metadata is incomplete; nothing will be overwritten.')
    }
    variables[env] = sortedVariables(Object.entries(config.env_vars ?? {}).map(([name, binding]) => {
      if (binding !== null && (!object(binding) || !['plain_text', 'secret_text'].includes(binding.type))) {
        fail('pages_metadata_invalid', 'Pages variable metadata is incomplete; nothing will be overwritten.')
      }
      return { name, type: binding?.type ?? null }
    }))
  }
  return { variables, config: project.deployment_configs[destination.environment] }
}

function verifyPages(state, receipt) {
  const { environment } = receipt.destination
  if (state.config.env_vars?.[SECRET_NAME]?.type !== 'secret_text') {
    fail('destination_mismatch', 'Installed receipt requires an existing secret_text destination; never recreate or overwrite it.')
  }
  const expected = {
    ...receipt.pagesVariables,
    [environment]: sortedVariables([...receipt.pagesVariables[environment], { name: SECRET_NAME, type: 'secret_text' }]),
  }
  if (!isDeepStrictEqual(state.variables, expected)) {
    fail('pages_variables_mismatch', 'Pages variable names/types changed outside the intended secret; operator review required. No values are reported.')
  }
}

function expectedRow(receipt) {
  return {
    id: receipt.client.id,
    name: receipt.client.name,
    secret_hash: receipt.secretHash,
    redirect_uris: JSON.stringify(receipt.client.redirectUris),
    post_logout_redirect_uris: '[]',
    disabled_at: null,
    created_at: receipt.at,
    created_by: receipt.actor,
    updated_at: receipt.at,
    updated_by: receipt.actor,
  }
}

/** All injected functions are for offline tests; the CLI has no override flags. */
export async function provision(options, dependencies = {}) {
  let lock
  let lockPath
  try {
    const env = dependencies.env ?? process.env
    const token = env.CLOUDFLARE_ADMIN_TOKEN
    if (!token) fail('token_missing', 'Set CLOUDFLARE_ADMIN_TOKEN in the environment.')
    const provider = dependencies.provider ?? await import('../../dist/provider/index.js')
    for (const key of ['id', 'name', 'account-id', 'database-id', 'pages-project', 'environment']) {
      if (typeof options[key] !== 'string' || !options[key].trim()) fail('usage', `--${key} is required.`)
    }
    if (provider.clientIdProblem(options.id)) fail('usage', 'Invalid --id; use the broker client ID policy.')
    if (!/^[a-f0-9]{32}$/.test(options['account-id'])) fail('usage', 'Invalid --account-id.')
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(options['database-id'])) fail('usage', 'Invalid --database-id.')
    if (!/^[a-z0-9][a-z0-9-]*$/.test(options['pages-project'])) fail('usage', 'Invalid --pages-project.')
    if (!['production', 'preview'].includes(options.environment)) fail('usage', '--environment must be production or preview.')
    if (!Array.isArray(options.callback) || !options.callback.length || options.callback.some(uri => provider.redirectUriProblem(uri, ['oa.dev']))) {
      fail('usage', '--callback must follow broker policy: canonical oa.dev HTTPS URLs or HTTP(S) loopback.')
    }
    if (new Set(options.callback).size !== options.callback.length) fail('usage', 'Duplicate --callback values are not allowed.')
    if (options.run && !options.receipt) fail('usage', '--receipt is required with --run.')
    const client = { id: options.id, name: options.name, redirectUris: options.callback }
    const destination = {
      accountId: options['account-id'],
      databaseId: options['database-id'],
      pagesProject: options['pages-project'],
      environment: options.environment,
      secretName: SECRET_NAME,
    }
    if (options.run) {
      lockPath = `${options.receipt}.lock`
      try { lock = await open(lockPath, 'wx', 0o600) } catch {
        fail('receipt_locked', 'Cannot lock receipt; review any existing lock before retrying.')
      }
    }
    let receipt = await readReceipt(options.receipt)
    if (receipt !== null) checkReceipt(receipt, client, destination)
    const fetch = dependencies.fetch ?? globalThis.fetch
    const base = `/accounts/${destination.accountId}`
    const d1 = `${base}/d1/database/${destination.databaseId}/query`
    const pages = `${base}/pages/projects/${destination.pagesProject}`
    const request = async (method, path, body, label) => {
      try {
        const response = await fetch(`${API}${path}`, {
          method,
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          redirect: 'error',
          signal: AbortSignal.timeout(30000),
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
        if (!response.ok) throw new Error()
        const data = await response.json()
        if (data.success !== true || data.result === undefined) throw new Error()
        return data.result
      } catch {
        // Neither transport errors nor Cloudflare errors/bodies are safe to echo.
        fail('cloudflare_request_failed', `${label} failed; response and error details suppressed.`)
      }
    }
    const query = async (body, count, label) => {
      const result = await request('POST', d1, body, label)
      if (!Array.isArray(result) || result.length !== count || result.some(r => r?.success !== true || !Array.isArray(r.results))) {
        fail('d1_result_invalid', `${label} returned an invalid result; details suppressed.`)
      }
      return result
    }
    const readClient = async () => {
      const [lookup] = await query({ sql: CLIENT_SQL, params: [client.id] }, 1, 'Client lookup')
      if (lookup.results.length > 1) fail('d1_result_invalid', 'Client lookup returned multiple rows; nothing will be overwritten.')
      return lookup.results[0] ?? null
    }
    const readPages = async () => pagesState(await request('GET', pages, undefined, 'Pages metadata lookup'), destination)
    const verifyClient = async row => {
      if (!isDeepStrictEqual(row, expectedRow(receipt))) fail('client_mismatch', 'Existing client differs from the receipt; nothing will be overwritten.')
      const [audit] = await query({ sql: AUDIT_SQL, params: [client.id] }, 1, 'Client audit lookup')
      if (!isDeepStrictEqual(audit.results, [{ client_id: client.id, action: 'create', actor: receipt.actor, at: receipt.at, detail: JSON.stringify(client.redirectUris) }])) {
        fail('audit_mismatch', 'Existing client audit differs from the receipt; operator review required.')
      }
    }
    const row = await readClient()
    const state = await readPages()
    const { config } = state
    const vars = config.env_vars ?? {}
    const present = Object.hasOwn(vars, SECRET_NAME)
    const summary = phase => ({ mode: options.run ? 'run' : 'dry-run', phase, client, destination })
    if (receipt) {
      if (receipt.phase === 'prepared' || receipt.phase === 'installing') {
        fail('installation_ambiguous', 'Pages installation is not confirmed by this receipt. Metadata cannot verify secret values; operator review required, never overwrite.')
      }
      verifyPages(state, receipt)
      if (row) {
        await verifyClient(row)
        if (options.run && receipt.phase !== 'registered') await writeReceipt(options.receipt, { ...receipt, phase: 'registered' })
        return summary('registered')
      }
      if (receipt.phase === 'registered') fail('client_missing', 'Registered receipt has no matching client; operator review required.')
      if (!options.run) return summary('would-register')
    } else {
      if (row) fail('client_exists', 'Client already exists without a matching installed receipt; nothing will be overwritten.')
      if (present) fail('destination_exists', 'Destination variable already exists without a matching installed receipt; nothing will be overwritten.')
      if (!options.run) return summary('would-install')
      let secret = await (dependencies.mintSecret ?? provider.mintClientSecret)()
      if (!digest(secret)) fail('mint_invalid', 'Secret mint did not return 256 bits encoded as base64url.')
      receipt = {
        version: 1,
        client,
        destination,
        secretHash: await provider.hashClientSecret(secret),
        actor: ACTOR,
        at: Math.floor((dependencies.now ?? Date.now)() / 1000),
        phase: 'prepared',
        pagesVariables: state.variables,
      }
      await writeReceipt(options.receipt, receipt, true)
      receipt.phase = 'installing'
      await writeReceipt(options.receipt, receipt)
      try {
        await request('PATCH', pages, {
          deployment_configs: {
            [destination.environment]: {
              env_vars: { [SECRET_NAME]: { type: 'secret_text', value: secret } },
              ...(Object.hasOwn(config, 'wrangler_config_hash') ? { wrangler_config_hash: config.wrangler_config_hash } : {}),
            },
          },
        }, 'Pages secret installation')
      } finally {
        secret = null
      }
      verifyPages(await readPages(), receipt)
      receipt.phase = 'installed'
      await writeReceipt(options.receipt, receipt)
    }
    // One REST request executes BOTH statements as a D1 batch, reusing the CLI's
    // SQL/escaping/audit format. No subprocess or credential-bearing stdout.
    await query({ sql: createSql({ ...client, secretHash: receipt.secretHash }, receipt.actor, receipt.at) }, 2, 'Client registration')
    const registered = await readClient()
    if (!registered) fail('registration_unverified', 'Client registration was not confirmed by read-back; inspect installed receipt before retrying.')
    await verifyClient(registered)
    verifyPages(await readPages(), receipt)
    await writeReceipt(options.receipt, { ...receipt, phase: 'registered' })
    return summary('registered')
  } catch (error) {
    if (error instanceof ProvisionError) throw error
    fail('provision_failed', 'Provisioning failed; details suppressed. Inspect non-secret receipt phase before retrying.')
  } finally {
    if (lock) {
      try {
        await lock.close()
        await unlink(lockPath)
      } catch {
        fail('receipt_unlock_failed', 'Receipt lock cleanup failed; review receipt and lock before retrying. Details suppressed.')
      }
    }
  }
}

export async function main(args = process.argv.slice(2), dependencies = {}) {
  const stdout = dependencies.stdout ?? (line => console.log(line))
  const stderr = dependencies.stderr ?? (line => console.error(line))
  try {
    const options = parseOptions(args)
    if (options.help) {
      stdout('provision-pages-client.mjs --id ID --name NAME --callback URI [--callback URI ...] --account-id ID --database-id UUID --pages-project PROJECT --environment production|preview [--receipt PATH] [--run]\nDry-run by default: remote reads only. --run requires a non-secret receipt. Token: CLOUDFLARE_ADMIN_TOKEN environment only.')
      return 0
    }
    stdout(JSON.stringify(await provision(options, dependencies)))
    return 0
  } catch (error) {
    const safe = error instanceof ProvisionError ? error : new ProvisionError('provision_failed', 'Provisioning failed; details suppressed.')
    stderr(JSON.stringify({ error: { code: safe.code, message: safe.message } }))
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main()
