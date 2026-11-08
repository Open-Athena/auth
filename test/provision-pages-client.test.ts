import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import * as provider from '../src/provider/index.js'
import { testDbRaw } from './d1-shim.js'
// @ts-expect-error Operational CLI is plain JavaScript, not a shipped TS module.
import { main, parseOptions, provision } from '../broker/scripts/provision-pages-client.mjs'

const SECRET = Buffer.alloc(32, 7).toString('base64url')
const TOKEN = 'test-only-admin-token-not-for-output'
const HASH = createHash('sha256').update(SECRET).digest('base64url')
const ACCOUNT = '0123456789abcdef0123456789abcdef'
const DATABASE = '12345678-1234-1234-1234-123456789abc'
const CALLBACKS = ['https://app.oa.dev/auth/oa/callback', 'http://localhost:3871/auth/oa/callback']
const CLIENT = { id: 'oa-app', name: "App's login", redirectUris: CALLBACKS }
const DESTINATION = { accountId: ACCOUNT, databaseId: DATABASE, pagesProject: 'app', environment: 'production', secretName: 'OA_LOGIN_CLIENT_SECRET' }
const BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}`
const CLIENT_SQL = 'SELECT id, name, secret_hash, redirect_uris, post_logout_redirect_uris, disabled_at, created_at, created_by, updated_at, updated_by FROM provider_clients WHERE id = ?'
const AUDIT_SQL = 'SELECT client_id, action, actor, at, detail FROM provider_client_events WHERE client_id = ? ORDER BY id'
const PAGES_VARIABLES = {
  production: [{ name: 'KEEP', type: 'plain_text' }, { name: 'OTHER_SECRET', type: 'secret_text' }],
  preview: [{ name: 'KEEP', type: 'plain_text' }],
}
const ARGS = [
  '--id', CLIENT.id, '--name', CLIENT.name,
  ...CALLBACKS.flatMap(uri => ['--callback', uri]),
  '--account-id', ACCOUNT, '--database-id', DATABASE,
  '--pages-project', 'app', '--environment', 'production',
]
const expectedReceipt = (phase: string, destination = DESTINATION) => ({
  version: 1, client: CLIENT, destination, secretHash: HASH,
  actor: 'cli:provision-pages-client', at: 1730000000, phase,
  pagesVariables: PAGES_VARIABLES,
})
const expectedRow = () => ({
  id: CLIENT.id, name: CLIENT.name, secret_hash: HASH,
  redirect_uris: JSON.stringify(CALLBACKS), post_logout_redirect_uris: '[]', disabled_at: null,
  created_at: 1730000000, created_by: 'cli:provision-pages-client',
  updated_at: 1730000000, updated_by: 'cli:provision-pages-client',
})
const expectedAudit = () => ({
  client_id: CLIENT.id, action: 'create', actor: 'cli:provision-pages-client',
  at: 1730000000, detail: JSON.stringify(CALLBACKS),
})
const summary = (mode: string, phase: string, destination = DESTINATION) => ({ mode, phase, client: CLIENT, destination })
const errorResult = (code: string, message: string) => ({
  status: 1, stdout: [], stderr: [JSON.stringify({ error: { code, message } })],
})
type Body = { sql?: string; params?: string[]; deployment_configs?: Record<string, { env_vars: Record<string, unknown>; wrangler_config_hash?: string | null }> }
type Request = { method: string; url: string; body: Body | null }
type Binding = { type: string; value?: string } | null
const dirs: string[] = []
const databases: ReturnType<typeof testDbRaw>['raw'][] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const db of databases.splice(0)) db.close()
  for (const path of dirs.splice(0)) await rm(path, { recursive: true, force: true })
})

async function setup(environment = 'production') {
  const root = resolve('tmp')
  await mkdir(root, { recursive: true })
  const dir = await mkdtemp(resolve(root, 'provision-pages-client-'))
  dirs.push(dir)
  const path = resolve(dir, 'receipt.json')
  const { raw } = testDbRaw(['provider'])
  databases.push(raw)
  const requests: Request[] = []
  const project = {
    name: 'app',
    deployment_configs: {
      production: { env_vars: { KEEP: { type: 'plain_text', value: 'keep' }, OTHER_SECRET: { type: 'secret_text' } } as Record<string, Binding>, wrangler_config_hash: 'prod-hash', compatibility_date: '2026-11-01' },
      preview: { env_vars: { KEEP: { type: 'plain_text', value: 'preview' } } as Record<string, Binding>, wrangler_config_hash: 'preview-hash', compatibility_date: '2026-11-02' },
    } as Record<string, { env_vars: Record<string, Binding>; wrangler_config_hash?: string | null; compatibility_date: string }>,
  }
  const controls = {
    patch: 'ok', register: 'ok', lookup: 'ok', metadata: 'ok', readback: 'ok',
    patchHook: async () => {},
  }
  const response = (result: unknown) => new Response(JSON.stringify({ success: true, result }), { status: 200 })
  const d1Result = (results: unknown[]) => ({ success: true, results, meta: {} })
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    expect(init.headers).toEqual({ Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' })
    expect(init.redirect).toBe('error')
    const body: Body | null = init.body ? JSON.parse(String(init.body)) : null
    requests.push({ method: init.method!, url, body })
    if (init.method === 'GET') {
      expect(url).toBe(`${BASE}/pages/projects/app`)
      if (controls.metadata === 'invalid') return response({ name: 'app' })
      return response(project)
    }
    if (init.method === 'PATCH') {
      await controls.patchHook()
      if (controls.patch === 'throw') throw new Error(`${TOKEN} ${SECRET}`)
      if (controls.patch === 'http-error') return new Response(`${TOKEN} ${SECRET}`, { status: 500 })
      if (controls.patch === 'bad-json') return new Response(`${TOKEN} ${SECRET}`, { status: 200 })
      if (controls.patch === 'api-error') return new Response(JSON.stringify({ success: false, errors: [{ message: `${TOKEN} ${SECRET}` }] }))
      if (controls.patch !== 'not-installed') {
        for (const [env, patch] of Object.entries(body!.deployment_configs!)) {
          Object.assign(project.deployment_configs[env]!.env_vars, patch.env_vars)
        }
      }
      if (controls.patch === 'drop-other') delete project.deployment_configs.production!.env_vars.OTHER_SECRET
      if (controls.patch === 'change-other-type') project.deployment_configs.preview!.env_vars.KEEP = { type: 'secret_text' }
      if (controls.patch === 'lost-response') throw new Error(`${TOKEN} ${SECRET}`)
      return response(project)
    }
    expect(url).toBe(`${BASE}/d1/database/${DATABASE}/query`)
    if (body!.params) {
      if (controls.lookup === 'nested-error') return response([{ success: false, error: `${TOKEN} ${SECRET}`, results: [] }])
      if (controls.lookup === 'extra-results') return response([d1Result([]), d1Result([])])
      if (body!.sql === CLIENT_SQL && raw.prepare('SELECT COUNT(*) AS n FROM provider_clients').get()!.n === 1) {
        if (controls.readback === 'missing') return response([d1Result([])])
        if (controls.readback === 'throw') throw new Error(`${TOKEN} ${SECRET}`)
      }
      return response([d1Result(raw.prepare(body!.sql!).all(...body!.params))])
    }
    if (controls.register === 'throw') throw new Error(`${TOKEN} ${SECRET}`)
    if (controls.register === 'no-write') return response([d1Result([]), d1Result([])])
    raw.exec('BEGIN')
    try {
      raw.exec(body!.sql!)
      raw.exec('COMMIT')
    } catch (error) {
      raw.exec('ROLLBACK')
      throw error
    }
    if (controls.register === 'lost-response') throw new Error(`${TOKEN} ${SECRET}`)
    if (controls.register === 'no-audit') raw.exec('DELETE FROM provider_client_events')
    if (controls.register === 'change-pages') project.deployment_configs.preview!.env_vars.KEEP = { type: 'secret_text' }
    return response([d1Result([]), d1Result([])])
  })
  const mintSecret = vi.fn(() => SECRET)
  const dependencies = { env: { CLOUDFLARE_ADMIN_TOKEN: TOKEN }, provider, fetch, mintSecret, now: () => 1730000000123 }
  const args = environment === 'production' ? ARGS : ARGS.map(value => value === 'production' ? environment : value)
  const options = parseOptions([...args, '--receipt', path, '--run'])
  const receipt = async () => JSON.parse(await readFile(path, 'utf8'))
  const invoke = async (argv = [...args, '--receipt', path, '--run'], overrides = {}) => {
    const stdout: string[] = []
    const stderr: string[] = []
    const status = await main(argv, { ...dependencies, ...overrides, stdout: (line: string) => stdout.push(line), stderr: (line: string) => stderr.push(line) })
    return { status, stdout, stderr }
  }
  const rows = () => raw.prepare('SELECT * FROM provider_clients').all()
  const audit = () => raw.prepare('SELECT client_id, action, actor, at, detail FROM provider_client_events ORDER BY id').all()
  return { dir, path, raw, requests, project, controls, dependencies, mintSecret, options, receipt, invoke, rows, audit }
}

describe('Pages broker client provisioning', () => {
  it('parses repeated callbacks, defaults to dry-run, and exposes no credential/rotation flags', async () => {
    const s = await setup()
    expect(parseOptions(ARGS)).toEqual({
      id: CLIENT.id, name: CLIENT.name, callback: CALLBACKS, 'account-id': ACCOUNT,
      'database-id': DATABASE, 'pages-project': 'app', environment: 'production', run: false, help: false,
    })
    expect(await s.invoke([...ARGS, '--secret', SECRET])).toEqual(errorResult('usage', 'Invalid arguments; use --help. Argument values are not echoed.'))
    expect(await s.invoke([...ARGS, '--rotate'])).toEqual(errorResult('usage', 'Invalid arguments; use --help. Argument values are not echoed.'))
    expect(s.requests).toEqual([])
  })

  it('dry-runs only bound SELECT and Pages metadata GET, with no mint, receipt, lock, or writes', async () => {
    const s = await setup()
    const before = structuredClone(s.project)
    expect(await s.invoke([...ARGS, '--receipt', s.path])).toEqual({ status: 0, stdout: [JSON.stringify(summary('dry-run', 'would-install'))], stderr: [] })
    expect(s.requests).toEqual([
      { method: 'POST', url: `${BASE}/d1/database/${DATABASE}/query`, body: { sql: CLIENT_SQL, params: [CLIENT.id] } },
      { method: 'GET', url: `${BASE}/pages/projects/app`, body: null },
    ])
    expect(s.mintSecret.mock.calls).toEqual([])
    expect(await readdir(s.dir)).toEqual([])
    expect(s.rows()).toEqual([])
    expect(s.audit()).toEqual([])
    expect(s.project).toEqual(before)
  })

  it('dry-runs without a receipt path', async () => {
    const s = await setup()
    expect(await s.invoke(ARGS)).toEqual({ status: 0, stdout: [JSON.stringify(summary('dry-run', 'would-install'))], stderr: [] })
    expect(await readdir(s.dir)).toEqual([])
  })

  it('requires a run receipt, explicit environment, and the admin ENV token (no ambient fallback)', async () => {
    const s = await setup()
    expect(await s.invoke([...ARGS, '--run'])).toEqual(errorResult('usage', '--receipt is required with --run.'))
    expect(await s.invoke(ARGS.slice(0, -2))).toEqual(errorResult('usage', '--environment is required.'))
    expect(await s.invoke(ARGS, { env: { CLOUDFLARE_API_TOKEN: TOKEN } })).toEqual(errorResult('token_missing', 'Set CLOUDFLARE_ADMIN_TOKEN in the environment.'))
    expect(s.requests).toEqual([])
    expect(await readdir(s.dir)).toEqual([])
  })

  it.each([
    ['--id', 'Bad-ID', 'Invalid --id; use the broker client ID policy.'],
    ['--account-id', '../account', 'Invalid --account-id.'],
    ['--database-id', 'bad-database', 'Invalid --database-id.'],
    ['--pages-project', '../app', 'Invalid --pages-project.'],
    ['--environment', 'staging', '--environment must be production or preview.'],
  ])('rejects invalid %s before any request', async (flag, value, message) => {
    const s = await setup()
    const args = [...ARGS]
    args[args.indexOf(flag) + 1] = value
    expect(await s.invoke(args)).toEqual(errorResult('usage', message))
    expect(s.requests).toEqual([])
  })

  it('rejects pages.dev callbacks and duplicate callbacks, keeping the broker callback policy', async () => {
    const s = await setup()
    expect(await s.invoke([...ARGS, '--callback', 'https://app.pages.dev/auth/oa/callback'])).toEqual(errorResult('usage', '--callback must follow broker policy: canonical oa.dev HTTPS URLs or HTTP(S) loopback.'))
    expect(await s.invoke([...ARGS, '--callback', CALLBACKS[0]!])).toEqual(errorResult('usage', 'Duplicate --callback values are not allowed.'))
    expect(s.requests).toEqual([])
  })

  it.each(['production', 'preview'])('installs ONLY the %s key before one client/audit SQL batch, retaining other configuration', async environment => {
    const s = await setup(environment)
    const before = structuredClone(s.project)
    const destination = { ...DESTINATION, environment }
    s.controls.patchHook = async () => {
      expect(await s.receipt()).toEqual(expectedReceipt('installing', destination))
      expect(s.rows()).toEqual([])
      expect(s.audit()).toEqual([])
    }
    expect(await s.invoke()).toEqual({ status: 0, stdout: [JSON.stringify(summary('run', 'registered', destination))], stderr: [] })
    expect(s.requests.map(({ method, body }) => ({ method, body }))).toEqual([
      { method: 'POST', body: { sql: CLIENT_SQL, params: [CLIENT.id] } },
      { method: 'GET', body: null },
      { method: 'PATCH', body: { deployment_configs: { [environment]: { env_vars: { OA_LOGIN_CLIENT_SECRET: { type: 'secret_text', value: SECRET } }, wrangler_config_hash: `${environment === 'production' ? 'prod' : 'preview'}-hash` } } } },
      { method: 'GET', body: null },
      { method: 'POST', body: { sql: `INSERT INTO provider_clients (id, name, secret_hash, redirect_uris, created_at, created_by, updated_at, updated_by) VALUES ('oa-app', 'App''s login', '${HASH}', '${JSON.stringify(CALLBACKS)}', 1730000000, 'cli:provision-pages-client', 1730000000, 'cli:provision-pages-client'); INSERT INTO provider_client_events (client_id, action, actor, at, detail) VALUES ('oa-app', 'create', 'cli:provision-pages-client', 1730000000, '${JSON.stringify(CALLBACKS)}')` } },
      { method: 'POST', body: { sql: CLIENT_SQL, params: [CLIENT.id] } },
      { method: 'POST', body: { sql: AUDIT_SQL, params: [CLIENT.id] } },
      { method: 'GET', body: null },
    ])
    before.deployment_configs[environment]!.env_vars.OA_LOGIN_CLIENT_SECRET = { type: 'secret_text', value: SECRET }
    expect(s.project).toEqual(before)
    expect(s.rows()).toEqual([expectedRow()])
    expect(s.audit()).toEqual([expectedAudit()])
    expect(await s.receipt()).toEqual(expectedReceipt('registered', destination))
    expect((await stat(s.path)).mode & 0o777).toBe(0o600)
    expect(await readdir(s.dir)).toEqual(['receipt.json'])
    expect(s.mintSecret.mock.calls).toEqual([[]])
    expect(await readFile(s.path, 'utf8')).toBe(`${JSON.stringify(expectedReceipt('registered', destination), null, 2)}\n`)
  })

  it.each([true, false])('refuses an existing client even with identical metadata (run=%s), without a receipt', async run => {
    const s = await setup()
    await provision(s.options, s.dependencies)
    s.requests.length = 0
    await rm(s.path)
    expect(await s.invoke([...ARGS, ...(run ? ['--run', '--receipt', s.path] : [])])).toEqual(errorResult('client_exists', 'Client already exists without a matching installed receipt; nothing will be overwritten.'))
    expect(s.requests.map(r => r.method)).toEqual(['POST', 'GET'])
    expect(s.rows()).toEqual([expectedRow()])
    expect(s.audit()).toEqual([expectedAudit()])
    expect(await readdir(s.dir)).toEqual([])
  })

  it.each([{ type: 'secret_text' }, { type: 'plain_text', value: SECRET }, null])('refuses every existing destination binding, including null, without minting', async binding => {
    const s = await setup()
    s.project.deployment_configs.production!.env_vars.OA_LOGIN_CLIENT_SECRET = binding
    expect(await s.invoke()).toEqual(errorResult('destination_exists', 'Destination variable already exists without a matching installed receipt; nothing will be overwritten.'))
    expect(s.requests.map(r => r.method)).toEqual(['POST', 'GET'])
    expect(s.mintSecret.mock.calls).toEqual([])
    expect(await readdir(s.dir)).toEqual([])
  })

  it.each(['throw', 'http-error', 'bad-json', 'api-error', 'lost-response'])('redacts Pages %s and refuses an ambiguous retry without touching the destination', async failure => {
    const s = await setup()
    s.controls.patch = failure
    expect(await s.invoke()).toEqual(errorResult('cloudflare_request_failed', 'Pages secret installation failed; response and error details suppressed.'))
    expect(await s.receipt()).toEqual(expectedReceipt('installing'))
    expect(s.rows()).toEqual([])
    expect(s.audit()).toEqual([])
    s.requests.length = 0
    s.controls.patch = 'ok'
    expect(await s.invoke()).toEqual(errorResult('installation_ambiguous', 'Pages installation is not confirmed by this receipt. Metadata cannot verify secret values; operator review required, never overwrite.'))
    expect(s.requests.map(r => r.method)).toEqual(['POST', 'GET'])
    expect(s.mintSecret.mock.calls).toEqual([[]])
    expect(await s.receipt()).toEqual(expectedReceipt('installing'))
  })

  it('resumes a failed D1 registration using the installed receipt hash, without minting or PATCH', async () => {
    const s = await setup()
    s.controls.register = 'throw'
    expect(await s.invoke()).toEqual(errorResult('cloudflare_request_failed', 'Client registration failed; response and error details suppressed.'))
    expect(await s.receipt()).toEqual(expectedReceipt('installed'))
    const installed = structuredClone(s.project)
    s.requests.length = 0
    const before = await readFile(s.path, 'utf8')
    expect(await s.invoke([...ARGS, '--receipt', s.path])).toEqual({ status: 0, stdout: [JSON.stringify(summary('dry-run', 'would-register'))], stderr: [] })
    expect(await readFile(s.path, 'utf8')).toBe(before)
    expect(s.requests.map(r => r.method)).toEqual(['POST', 'GET'])
    s.requests.length = 0
    s.controls.register = 'ok'
    expect(await s.invoke()).toEqual({ status: 0, stdout: [JSON.stringify(summary('run', 'registered'))], stderr: [] })
    expect(s.requests.map(r => r.method)).toEqual(['POST', 'GET', 'POST', 'POST', 'POST', 'GET'])
    expect(s.project).toEqual(installed)
    expect(s.rows()).toEqual([expectedRow()])
    expect(s.audit()).toEqual([expectedAudit()])
    expect(s.mintSecret.mock.calls).toEqual([[]])
    expect(await s.receipt()).toEqual(expectedReceipt('registered'))
  })

  it('recognizes committed registration after a lost D1 response and completed retries without duplicate audit', async () => {
    const s = await setup()
    s.controls.register = 'lost-response'
    expect(await s.invoke()).toEqual(errorResult('cloudflare_request_failed', 'Client registration failed; response and error details suppressed.'))
    expect(await s.receipt()).toEqual(expectedReceipt('installed'))
    for (const phase of ['installed', 'registered']) {
      expect((await s.receipt()).phase).toBe(phase)
      s.requests.length = 0
      expect(await s.invoke()).toEqual({ status: 0, stdout: [JSON.stringify(summary('run', 'registered'))], stderr: [] })
      expect(s.requests.map(r => r.method)).toEqual(['POST', 'GET', 'POST'])
      expect(s.requests[2]!.body).toEqual({ sql: AUDIT_SQL, params: [CLIENT.id] })
      expect(s.rows()).toEqual([expectedRow()])
      expect(s.audit()).toEqual([expectedAudit()])
    }
    expect(s.mintSecret.mock.calls).toEqual([[]])
  })

  it('leaves the confirmed Pages credential installed after audit SQL failure; retries the entire SQL batch', async () => {
    const s = await setup()
    s.raw.exec("CREATE TRIGGER reject_audit BEFORE INSERT ON provider_client_events BEGIN SELECT RAISE(ABORT, 'test audit failure'); END")
    expect(await s.invoke()).toEqual(errorResult('cloudflare_request_failed', 'Client registration failed; response and error details suppressed.'))
    expect(await s.receipt()).toEqual(expectedReceipt('installed'))
    expect(s.rows()).toEqual([])
    expect(s.audit()).toEqual([])
    s.raw.exec('DROP TRIGGER reject_audit')
    s.requests.length = 0
    expect(await s.invoke()).toEqual({ status: 0, stdout: [JSON.stringify(summary('run', 'registered'))], stderr: [] })
    expect(s.requests.map(r => r.method)).toEqual(['POST', 'GET', 'POST', 'POST', 'POST', 'GET'])
    expect(s.rows()).toEqual([expectedRow()])
    expect(s.audit()).toEqual([expectedAudit()])
  })

  it('does not trust successful Pages PATCH if a fresh GET cannot see the installed key', async () => {
    const s = await setup()
    s.controls.patch = 'not-installed'
    expect(await s.invoke()).toEqual(errorResult('destination_mismatch', 'Installed receipt requires an existing secret_text destination; never recreate or overwrite it.'))
    expect(s.requests.map(r => r.method)).toEqual(['POST', 'GET', 'PATCH', 'GET'])
    expect(await s.receipt()).toEqual(expectedReceipt('installing'))
    expect(s.rows()).toEqual([])
    expect(s.audit()).toEqual([])
  })

  it.each(['drop-other', 'change-other-type'])('detects %s on a fresh Pages GET before creating a client', async failure => {
    const s = await setup()
    s.controls.patch = failure
    expect(await s.invoke()).toEqual(errorResult('pages_variables_mismatch', 'Pages variable names/types changed outside the intended secret; operator review required. No values are reported.'))
    expect(s.requests.map(r => r.method)).toEqual(['POST', 'GET', 'PATCH', 'GET'])
    expect(await s.receipt()).toEqual(expectedReceipt('installing'))
    expect(s.rows()).toEqual([])
    expect(s.audit()).toEqual([])
  })

  it('does not trust a successful registration response when the row is missing on read-back', async () => {
    const s = await setup()
    s.controls.register = 'no-write'
    expect(await s.invoke()).toEqual(errorResult('registration_unverified', 'Client registration was not confirmed by read-back; inspect installed receipt before retrying.'))
    expect(s.requests.map(r => r.method)).toEqual(['POST', 'GET', 'PATCH', 'GET', 'POST', 'POST'])
    expect(await s.receipt()).toEqual(expectedReceipt('installed'))
    expect(s.rows()).toEqual([])
    expect(s.audit()).toEqual([])
    s.controls.register = 'ok'
    s.requests.length = 0
    expect(await s.invoke()).toEqual({ status: 0, stdout: [JSON.stringify(summary('run', 'registered'))], stderr: [] })
    expect(s.requests.map(r => r.method)).toEqual(['POST', 'GET', 'POST', 'POST', 'POST', 'GET'])
  })

  it('requires a fresh audit read, not merely two successful SQL result objects', async () => {
    const s = await setup()
    s.controls.register = 'no-audit'
    expect(await s.invoke()).toEqual(errorResult('audit_mismatch', 'Existing client audit differs from the receipt; operator review required.'))
    expect(s.requests.map(r => r.method)).toEqual(['POST', 'GET', 'PATCH', 'GET', 'POST', 'POST', 'POST'])
    expect(await s.receipt()).toEqual(expectedReceipt('installed'))
    expect(s.rows()).toEqual([expectedRow()])
    expect(s.audit()).toEqual([])
  })

  it('reads Pages again after registration and refuses any unrelated environment metadata drift', async () => {
    const s = await setup()
    s.controls.register = 'change-pages'
    expect(await s.invoke()).toEqual(errorResult('pages_variables_mismatch', 'Pages variable names/types changed outside the intended secret; operator review required. No values are reported.'))
    expect(s.requests.map(r => r.method)).toEqual(['POST', 'GET', 'PATCH', 'GET', 'POST', 'POST', 'POST', 'GET'])
    expect(await s.receipt()).toEqual(expectedReceipt('installed'))
    expect(s.rows()).toEqual([expectedRow()])
    expect(s.audit()).toEqual([expectedAudit()])
    s.requests.length = 0
    expect(await s.invoke()).toEqual(errorResult('pages_variables_mismatch', 'Pages variable names/types changed outside the intended secret; operator review required. No values are reported.'))
    expect(s.requests.map(r => r.method)).toEqual(['POST', 'GET'])
  })

  it('redacts transport failure during registration read-back and resumes without another write', async () => {
    const s = await setup()
    s.controls.readback = 'throw'
    expect(await s.invoke()).toEqual(errorResult('cloudflare_request_failed', 'Client lookup failed; response and error details suppressed.'))
    expect(s.requests.map(r => r.method)).toEqual(['POST', 'GET', 'PATCH', 'GET', 'POST', 'POST'])
    expect(await s.receipt()).toEqual(expectedReceipt('installed'))
    s.controls.readback = 'ok'
    s.requests.length = 0
    expect(await s.invoke()).toEqual({ status: 0, stdout: [JSON.stringify(summary('run', 'registered'))], stderr: [] })
    expect(s.requests.map(r => r.method)).toEqual(['POST', 'GET', 'POST'])
    expect(s.rows()).toEqual([expectedRow()])
    expect(s.audit()).toEqual([expectedAudit()])
    expect(s.mintSecret.mock.calls).toEqual([[]])
  })

  it('uses the provider 256-bit mint and SHA256/base64url hash without writing any secret values to its receipt', async () => {
    const s = await setup()
    const { mintSecret: _unused, ...dependencies } = s.dependencies
    expect(await provision(s.options, dependencies)).toEqual(summary('run', 'registered'))
    const patch = s.requests.find(r => r.method === 'PATCH')!
    const binding = patch.body!.deployment_configs!.production!.env_vars.OA_LOGIN_CLIENT_SECRET as { value: string }
    expect(Buffer.from(binding.value, 'base64url').length).toBe(32)
    const hash = createHash('sha256').update(binding.value).digest('base64url')
    expect(await provider.hashClientSecret(binding.value)).toBe(hash)
    const receipt = await s.receipt()
    expect(receipt).toEqual({ ...expectedReceipt('registered'), secretHash: hash })
    expect(await readFile(s.path, 'utf8')).toBe(`${JSON.stringify({ ...expectedReceipt('registered'), secretHash: hash }, null, 2)}\n`)
    expect(s.rows()).toEqual([{ ...expectedRow(), secret_hash: hash }])
    expect(s.audit()).toEqual([expectedAudit()])
    expect(s.mintSecret.mock.calls).toEqual([])
  })

  it.each(['client', 'destination', 'secretHash', 'phase', 'extra'])('refuses mismatched or malformed receipt %s before remote requests', async field => {
    const s = await setup()
    const receipt: Record<string, unknown> = expectedReceipt('installed')
    receipt[field] = field === 'extra' ? SECRET : 'mismatch'
    await writeFile(s.path, JSON.stringify(receipt))
    expect(await s.invoke()).toEqual(errorResult('receipt_mismatch', 'Receipt does not exactly match this operation; nothing will be overwritten.'))
    expect(s.requests).toEqual([])
    expect(s.mintSecret.mock.calls).toEqual([])
  })

  it.each(['prepared', 'installing'])('fails closed for a %s receipt even if no remote secret is visible', async phase => {
    const s = await setup()
    await writeFile(s.path, JSON.stringify(expectedReceipt(phase)))
    expect(await s.invoke()).toEqual(errorResult('installation_ambiguous', 'Pages installation is not confirmed by this receipt. Metadata cannot verify secret values; operator review required, never overwrite.'))
    expect(s.requests.map(r => r.method)).toEqual(['POST', 'GET'])
    expect(s.mintSecret.mock.calls).toEqual([])
  })

  it.each(['missing', 'plain_text'])('does not recreate or change a %s destination under an installed receipt', async kind => {
    const s = await setup()
    await writeFile(s.path, JSON.stringify(expectedReceipt('installed')))
    if (kind === 'plain_text') s.project.deployment_configs.production!.env_vars.OA_LOGIN_CLIENT_SECRET = { type: 'plain_text', value: SECRET }
    expect(await s.invoke()).toEqual(errorResult('destination_mismatch', 'Installed receipt requires an existing secret_text destination; never recreate or overwrite it.'))
    expect(s.requests.map(r => r.method)).toEqual(['POST', 'GET'])
    expect(s.mintSecret.mock.calls).toEqual([])
  })

  it.each([
    "UPDATE provider_clients SET name = 'changed'",
    "UPDATE provider_clients SET redirect_uris = '[]'",
    "UPDATE provider_clients SET post_logout_redirect_uris = '[\"https://app.oa.dev/\"]'",
    "UPDATE provider_clients SET secret_hash = 'different'",
    'UPDATE provider_clients SET disabled_at = 1',
    'UPDATE provider_clients SET updated_at = 1',
  ])('refuses client metadata drift: %s', async sql => {
    const s = await setup()
    await provision(s.options, s.dependencies)
    s.raw.exec(sql)
    s.requests.length = 0
    expect(await s.invoke()).toEqual(errorResult('client_mismatch', 'Existing client differs from the receipt; nothing will be overwritten.'))
    expect(s.requests.map(r => r.method)).toEqual(['POST', 'GET'])
    expect(s.audit()).toEqual([expectedAudit()])
  })

  it('refuses missing audit and missing registered client without repairing or silently recreating', async () => {
    const s = await setup()
    await provision(s.options, s.dependencies)
    s.raw.exec('DELETE FROM provider_client_events')
    s.requests.length = 0
    expect(await s.invoke()).toEqual(errorResult('audit_mismatch', 'Existing client audit differs from the receipt; operator review required.'))
    expect(s.requests.map(r => r.method)).toEqual(['POST', 'GET', 'POST'])
    s.raw.exec('DELETE FROM provider_clients')
    s.requests.length = 0
    expect(await s.invoke()).toEqual(errorResult('client_missing', 'Registered receipt has no matching client; operator review required.'))
    expect(s.requests.map(r => r.method)).toEqual(['POST', 'GET'])
    expect(s.rows()).toEqual([])
    expect(s.audit()).toEqual([])
  })

  it('does not auto-takeover an existing receipt lock', async () => {
    const s = await setup()
    await writeFile(`${s.path}.lock`, 'other writer')
    expect(await s.invoke()).toEqual(errorResult('receipt_locked', 'Cannot lock receipt; review any existing lock before retrying.'))
    expect(s.requests).toEqual([])
    expect(await readFile(`${s.path}.lock`, 'utf8')).toBe('other writer')
  })

  it('redacts malformed receipt contents and mint errors, and releases its own lock', async () => {
    const s = await setup()
    await writeFile(s.path, `${TOKEN} ${SECRET}`)
    expect(await s.invoke()).toEqual(errorResult('receipt_invalid', 'Cannot read a valid non-secret receipt; details suppressed.'))
    await rm(s.path)
    expect(await s.invoke(undefined, { mintSecret: () => { throw new Error(`${TOKEN} ${SECRET}`) } })).toEqual(errorResult('provision_failed', 'Provisioning failed; details suppressed. Inspect non-secret receipt phase before retrying.'))
    expect(await readdir(s.dir)).toEqual([])
  })

  it.each(['nested-error', 'extra-results'])('refuses unexpected D1 response %s without exposing API error bodies', async kind => {
    const s = await setup()
    s.controls.lookup = kind
    expect(await s.invoke()).toEqual(errorResult('d1_result_invalid', 'Client lookup returned an invalid result; details suppressed.'))
    expect(s.requests.map(r => r.method)).toEqual(['POST'])
    expect(await readdir(s.dir)).toEqual([])
  })

  it('refuses incomplete Pages metadata', async () => {
    const s = await setup()
    s.controls.metadata = 'invalid'
    expect(await s.invoke()).toEqual(errorResult('pages_metadata_invalid', 'Pages environment metadata is incomplete; nothing will be overwritten.'))
    expect(s.requests.map(r => r.method)).toEqual(['POST', 'GET'])
    expect(await readdir(s.dir)).toEqual([])
  })

  it('prints safe help without environment, build, or network access', async () => {
    const s = await setup()
    expect(await s.invoke(['--help'], { env: {} })).toEqual({
      status: 0,
      stdout: ['provision-pages-client.mjs --id ID --name NAME --callback URI [--callback URI ...] --account-id ID --database-id UUID --pages-project PROJECT --environment production|preview [--receipt PATH] [--run]\nDry-run by default: remote reads only. --run requires a non-secret receipt. Token: CLOUDFLARE_ADMIN_TOKEN environment only.'],
      stderr: [],
    })
    expect(s.requests).toEqual([])
  })
})
