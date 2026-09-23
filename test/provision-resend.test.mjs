/**
 * The Resend provisioning CLI, driven end to end with an injected `fetch` and `exec`
 * so nothing reaches a network or a shell. Every assertion is an exact request
 * sequence or an exact list of printed lines — the tests are the spec of what a run
 * does, including what a dry run does not.
 */
import { describe, expect, it } from 'vitest'
import {
  CF_API,
  DMARC_VALUE,
  RESEND_API,
  STEPS,
  UsageError,
  dmarcRecord,
  dnsRecordBody,
  formatCommand,
  formatRecords,
  fqdn,
  main,
  normalizeContent,
  parseArgs,
  secretPutArgs,
  validateFrom,
} from '../scripts/provision-resend.mjs'

/** Run `fn`, return the thrown error (or null) — so a message can be asserted exactly. */
const caught = fn => {
  try {
    fn()
    return null
  } catch (e) {
    return e
  }
}
const caughtAsync = async p => {
  try {
    await p
    return null
  } catch (e) {
    return e
  }
}

const DOMAIN = 'oa.dev'
const ZONE = 'zone123'
const KEY = 're_test_key_0123456789'
const ENV = { RESEND_API_KEY: KEY, CLOUDFLARE_API_TOKEN: 'cf_test_token' }

/** What Resend returns for the domain — the shapes from its API reference. */
const RECORDS = [
  { record: 'SPF', name: 'send', type: 'MX', ttl: 'Auto', status: 'not_started', value: 'feedback-smtp.us-east-1.amazonses.com', priority: 10 },
  { record: 'SPF', name: 'send', type: 'TXT', ttl: 'Auto', status: 'not_started', value: '"v=spf1 include:amazonses.com ~all"' },
  { record: 'DKIM', name: 'resend._domainkey', type: 'CNAME', ttl: 'Auto', status: 'not_started', value: 'resend.dkim.amazonses.com.' },
  { record: 'Tracking', name: 'links.oa.dev', type: 'CNAME', ttl: 'Auto', status: 'not_started', value: 'links1.resend-dns.com' },
]
const domainJson = (status = 'not_started') => ({ object: 'domain', id: 'dom-1', name: DOMAIN, status, region: 'us-east-1', records: RECORDS })

const RECORD_TABLE = [
  `create: ${DOMAIN} wants these records (4):`,
  '  SPF       MX     send.oa.dev               10  feedback-smtp.us-east-1.amazonses.com',
  '  SPF       TXT    send.oa.dev                   "v=spf1 include:amazonses.com ~all"',
  '  DKIM      CNAME  resend._domainkey.oa.dev      resend.dkim.amazonses.com.',
  '  Tracking  CNAME  links.oa.dev                  links1.resend-dns.com',
]
const REUSED = `create: ${DOMAIN} already exists in Resend (id dom-1, status not_started, region us-east-1) — reusing`
const DRY_DONE = 'dry run complete — nothing was created; add --run to apply'

/** The Cloudflare list URL the script uses for one record name/type. */
const cfList = (name, type) => `${CF_API}/zones/${ZONE}/dns_records?name=${encodeURIComponent(name)}&type=${type}&per_page=100`
const cfCreate = `${CF_API}/zones/${ZONE}/dns_records`
const cfRow = (id, content) => ({ id, content })

/**
 * Drive `main` against a table of canned responses. `routes` maps `METHOD url` to a
 * JSON body (or a function of the parsed request body → JSON). Returns the exact
 * request sequence, printed lines, exec calls, sleeps, and exit code.
 */
async function run(argv, { routes = {}, env = ENV } = {}) {
  const calls = []
  const lines = []
  const execs = []
  const sleeps = []
  const fetch = async (url, init = {}) => {
    const method = init.method ?? 'GET'
    const body = init.body === undefined ? undefined : JSON.parse(init.body)
    calls.push(body === undefined ? { method, url } : { method, url, body })
    const auth = init.headers?.authorization
    const expectedToken = url.startsWith(CF_API) ? ENV.CLOUDFLARE_API_TOKEN : ENV.RESEND_API_KEY
    if (auth !== `Bearer ${expectedToken}`) return { ok: false, status: 401, text: async () => 'bad token' }
    const route = routes[`${method} ${url}`]
    if (route === undefined) return { ok: false, status: 404, text: async () => `no route for ${method} ${url}` }
    const json = typeof route === 'function' ? route(body) : route
    return { ok: true, status: 200, text: async () => JSON.stringify(json) }
  }
  const code = await main(argv, {
    env,
    fetch,
    exec: (cmd, args, input) => execs.push({ cmd, args, input }),
    err: l => lines.push(l),
    sleep: async s => sleeps.push(s),
  })
  return { calls, lines, execs, sleeps, code }
}

const listRoutes = (data = [{ id: 'dom-1', name: DOMAIN, status: 'not_started', region: 'us-east-1' }]) => ({
  [`GET ${RESEND_API}/domains?limit=100`]: { object: 'list', data, has_more: false },
})
const existingDomain = (status = 'not_started') => ({
  ...listRoutes([{ id: 'dom-1', name: DOMAIN, status, region: 'us-east-1' }]),
  [`GET ${RESEND_API}/domains/dom-1`]: domainJson(status),
})

describe('pure helpers', () => {
  it('fqdn: qualifies relative names, keeps qualified ones, drops a trailing dot', () => {
    expect(fqdn('send', DOMAIN)).toBe('send.oa.dev')
    expect(fqdn('resend._domainkey', DOMAIN)).toBe('resend._domainkey.oa.dev')
    expect(fqdn('links.oa.dev', DOMAIN)).toBe('links.oa.dev')
    expect(fqdn('links.oa.dev.', DOMAIN)).toBe('links.oa.dev')
    expect(fqdn(DOMAIN, DOMAIN)).toBe(DOMAIN)
    expect(fqdn('oa.dev.evil.com', DOMAIN)).toBe('oa.dev.evil.com.oa.dev')
  })

  it('normalizeContent: strips TXT outer quotes, hostname trailing dots and case', () => {
    expect(normalizeContent('TXT', '"v=spf1 include:amazonses.com ~all"')).toBe('v=spf1 include:amazonses.com ~all')
    expect(normalizeContent('TXT', 'v=spf1 include:amazonses.com ~all')).toBe('v=spf1 include:amazonses.com ~all')
    expect(normalizeContent('CNAME', 'Resend.DKIM.amazonses.com.')).toBe('resend.dkim.amazonses.com')
    expect(normalizeContent('MX', 'feedback-smtp.us-east-1.amazonses.com')).toBe('feedback-smtp.us-east-1.amazonses.com')
  })

  it('dnsRecordBody: the exact Cloudflare create body, priority only for MX', () => {
    expect(dnsRecordBody(RECORDS[0], DOMAIN)).toEqual({
      type: 'MX',
      name: 'send.oa.dev',
      content: 'feedback-smtp.us-east-1.amazonses.com',
      ttl: 1,
      comment: 'resend: SPF',
      priority: 10,
    })
    expect(dnsRecordBody(RECORDS[1], DOMAIN)).toEqual({
      type: 'TXT',
      name: 'send.oa.dev',
      content: '"v=spf1 include:amazonses.com ~all"',
      ttl: 1,
      comment: 'resend: SPF',
    })
    expect(dnsRecordBody(RECORDS[2], DOMAIN)).toEqual({
      type: 'CNAME',
      name: 'resend._domainkey.oa.dev',
      content: 'resend.dkim.amazonses.com',
      ttl: 1,
      comment: 'resend: DKIM',
    })
    expect(dmarcRecord(DOMAIN)).toEqual({ record: 'DMARC', name: '_dmarc.oa.dev', type: 'TXT', value: 'v=DMARC1; p=none;' })
    expect(DMARC_VALUE).toBe('v=DMARC1; p=none;')
  })

  it('validateFrom: bare or display-name form, at the domain only', () => {
    expect(validateFrom('noreply@oa.dev', DOMAIN)).toBe('noreply@oa.dev')
    expect(validateFrom('  Reports <noreply@OA.dev> ', DOMAIN)).toBe('Reports <noreply@OA.dev>')
    expect(caught(() => validateFrom('noreply@example.org', DOMAIN)).message).toBe('--from must be at oa.dev, got "noreply@example.org"')
    expect(caught(() => validateFrom('noreply@sub.oa.dev', DOMAIN)).message).toBe('--from must be at oa.dev, got "noreply@sub.oa.dev"')
    expect(caught(() => validateFrom('not an address', DOMAIN)).message).toBe('--from must be an email address, got "not an address"')
  })

  it('secretPutArgs + formatCommand: the wrangler argv, value absent', () => {
    expect(secretPutArgs('RESEND_API_KEY', { pagesProject: 'myapp', worker: null })).toEqual([
      'pages', 'secret', 'put', 'RESEND_API_KEY', '--project-name', 'myapp',
    ])
    expect(secretPutArgs('MAIL_FROM', { pagesProject: null, worker: 'my-worker' })).toEqual([
      'secret', 'put', 'MAIL_FROM', '--name', 'my-worker',
    ])
    expect(formatCommand('npx', ['wrangler', ...secretPutArgs('MAIL_FROM', { pagesProject: 'my app' })])).toBe(
      "npx wrangler pages secret put MAIL_FROM --project-name 'my app'",
    )
  })

  it('formatRecords: aligned columns; the priority column only when some record has one', () => {
    expect(formatRecords(RECORDS, DOMAIN)).toEqual(RECORD_TABLE.slice(1))
    expect(formatRecords(RECORDS.slice(2), DOMAIN)).toEqual([
      '  DKIM      CNAME  resend._domainkey.oa.dev  resend.dkim.amazonses.com.',
      '  Tracking  CNAME  links.oa.dev              links1.resend-dns.com',
    ])
    expect(formatRecords([], DOMAIN)).toEqual([])
  })
})

describe('parseArgs', () => {
  it('parses the full flag set', () => {
    expect(
      parseArgs([
        '--domain', 'OA.dev.',
        '--zone-id', ZONE,
        '--from', 'noreply@oa.dev',
        '--pages-project', 'myapp',
        '--region', 'eu-west-1',
        '--return-path', 'bounce',
        '--dmarc',
        '--wait', '600',
        '--only', 'verify,create',
        '--run',
      ]),
    ).toEqual({
      domain: 'oa.dev',
      zoneId: ZONE,
      from: 'noreply@oa.dev',
      pagesProject: 'myapp',
      worker: null,
      region: 'eu-west-1',
      returnPath: 'bounce',
      dmarc: true,
      wait: 600,
      only: ['create', 'verify'],
      run: true,
      help: false,
    })
  })

  it('defaults: every step, us-east-1, `send`, no wait, dry run', () => {
    const o = parseArgs(['--domain', DOMAIN, '--zone-id', ZONE, '--from', 'a@oa.dev', '--worker', 'w'])
    expect([o.only, o.region, o.returnPath, o.dmarc, o.wait, o.run, o.pagesProject, o.worker]).toEqual([
      STEPS, 'us-east-1', 'send', false, 0, false, null, 'w',
    ])
  })

  it('requires per-step flags only for the steps selected', () => {
    expect(caught(() => parseArgs([])).message).toBe('--domain is required')
    expect(caught(() => parseArgs(['--domain', DOMAIN])).message).toBe('--zone-id is required for the dns step')
    expect(caught(() => parseArgs(['--domain', DOMAIN, '--zone-id', ZONE])).message).toBe('--from is required for the secrets step')
    expect(caught(() => parseArgs(['--domain', DOMAIN, '--zone-id', ZONE, '--from', 'a@oa.dev'])).message).toBe(
      '--pages-project or --worker is required for the secrets step',
    )
    expect(parseArgs(['--domain', DOMAIN, '--only', 'create,verify']).only).toEqual(['create', 'verify'])
    expect(parseArgs(['--domain', DOMAIN, '--only', 'dns', '--zone-id', ZONE]).only).toEqual(['dns'])
  })

  it('rejects malformed values', () => {
    expect(caught(() => parseArgs(['--domain', 'not a domain', '--only', 'create'])).message).toBe(
      '--domain must be a bare domain name, got "not a domain"',
    )
    expect(caught(() => parseArgs(['--domain', DOMAIN, '--only', 'create', '--region', 'mars'])).message).toBe(
      '--region must be one of us-east-1, eu-west-1, sa-east-1, ap-northeast-1, got "mars"',
    )
    expect(caught(() => parseArgs(['--domain', DOMAIN, '--only', 'create', '--wait', '-1'])).message).toBe(
      '--wait must be a non-negative integer (seconds), got "-1"',
    )
    expect(caught(() => parseArgs(['--domain', DOMAIN, '--only', 'create,nope'])).message).toBe(
      '--only: unknown step "nope" (choose from create, dns, verify, secrets)',
    )
    expect(caught(() => parseArgs(['--domain', DOMAIN, '--only', 'secrets', '--from', 'a@oa.dev', '--pages-project', 'p', '--worker', 'w'])).message).toBe(
      '--pages-project and --worker are mutually exclusive',
    )
    expect(caught(() => parseArgs(['--domain', DOMAIN, '--only', 'secrets', '--from', 'a@elsewhere.org', '--worker', 'w'])).message).toBe(
      '--from must be at oa.dev, got "a@elsewhere.org"',
    )
    expect(caught(() => parseArgs(['--nope'])).message).toBe('unknown argument "--nope"')
    expect(caught(() => parseArgs(['--domain'])).message).toBe('--domain needs a value')
  })

  it('skips required-flag checks under --help', () => {
    expect(parseArgs(['--help']).help).toBe(true)
  })
})

describe('create', () => {
  it('reuses an existing domain: two GETs, no POST, the record table', async () => {
    const { calls, lines, execs, code } = await run(['--domain', DOMAIN, '--only', 'create', '--run'], { routes: existingDomain() })
    expect(calls).toEqual([
      { method: 'GET', url: `${RESEND_API}/domains?limit=100` },
      { method: 'GET', url: `${RESEND_API}/domains/dom-1` },
    ])
    expect(lines).toEqual([REUSED, ...RECORD_TABLE, 'done'])
    expect(execs).toEqual([])
    expect(code).toBe(0)
  })

  it('follows the list cursor and matches the name case-insensitively', async () => {
    const routes = {
      [`GET ${RESEND_API}/domains?limit=100`]: { object: 'list', data: [{ id: 'other', name: 'other.org' }], has_more: true },
      [`GET ${RESEND_API}/domains?limit=100&after=other`]: { object: 'list', data: [{ id: 'dom-1', name: 'OA.dev' }], has_more: false },
      [`GET ${RESEND_API}/domains/dom-1`]: domainJson(),
    }
    const { calls } = await run(['--domain', DOMAIN, '--only', 'create'], { routes })
    expect(calls).toEqual([
      { method: 'GET', url: `${RESEND_API}/domains?limit=100` },
      { method: 'GET', url: `${RESEND_API}/domains?limit=100&after=other` },
      { method: 'GET', url: `${RESEND_API}/domains/dom-1` },
    ])
  })

  it('creates the domain when absent (--run): the exact POST body', async () => {
    const routes = {
      ...listRoutes([]),
      [`POST ${RESEND_API}/domains`]: body => ({ ...domainJson(), name: body.name, region: body.region }),
    }
    const { calls, lines, code } = await run(
      ['--domain', DOMAIN, '--only', 'create', '--region', 'eu-west-1', '--return-path', 'bounce', '--run'],
      { routes },
    )
    expect(calls).toEqual([
      { method: 'GET', url: `${RESEND_API}/domains?limit=100` },
      { method: 'POST', url: `${RESEND_API}/domains`, body: { name: DOMAIN, region: 'eu-west-1', custom_return_path: 'bounce' } },
    ])
    expect(lines).toEqual([`create: created ${DOMAIN} in Resend (id dom-1, region eu-west-1)`, ...RECORD_TABLE, 'done'])
    expect(code).toBe(0)
  })

  it('dry run with no domain: prints the POST it would send, sends nothing', async () => {
    const { calls, lines, execs } = await run(['--domain', DOMAIN, '--only', 'create,dns,verify', '--zone-id', ZONE], { routes: listRoutes([]) })
    expect(calls).toEqual([{ method: 'GET', url: `${RESEND_API}/domains?limit=100` }])
    expect(lines).toEqual([
      `create: [dry-run] would POST ${RESEND_API}/domains {"name":"oa.dev","region":"us-east-1","custom_return_path":"send"}`,
      'create: records are minted on creation — re-run with --run (or --only create --run) to see them',
      'dns: nothing to write yet (no domain records)',
      'verify: nothing to verify yet (no domain)',
      DRY_DONE,
    ])
    expect(execs).toEqual([])
  })

  it('refuses to proceed without the domain when create is not selected', async () => {
    const e = await caughtAsync(run(['--domain', DOMAIN, '--only', 'verify'], { routes: listRoutes([]) }))
    expect(e instanceof UsageError).toBe(true)
    expect(e.message).toBe('oa.dev is not registered in Resend; include create in --only (or drop --only)')
  })
})

describe('dns', () => {
  const present = {
    // MX present (Cloudflare echoes the target without a dot), TXT present with the
    // quotes stripped, DKIM absent, Tracking present with a different target (stale).
    [`GET ${cfList('send.oa.dev', 'MX')}`]: { result: [cfRow('mx1', 'feedback-smtp.us-east-1.amazonses.com')] },
    [`GET ${cfList('send.oa.dev', 'TXT')}`]: { result: [cfRow('txt1', 'v=spf1 include:amazonses.com ~all')] },
    [`GET ${cfList('resend._domainkey.oa.dev', 'CNAME')}`]: { result: [] },
    [`GET ${cfList('links.oa.dev', 'CNAME')}`]: { result: [cfRow('cn9', 'links9.resend-dns.com')] },
    [`POST ${cfCreate}`]: body => ({ result: { id: `new-${body.type}`, name: body.name, content: body.content } }),
  }

  it('skips records already present (normalized) and creates the rest with FQDN names', async () => {
    const { calls, lines, code } = await run(['--domain', DOMAIN, '--only', 'dns', '--zone-id', ZONE, '--run'], {
      routes: { ...existingDomain(), ...present },
    })
    expect(calls.slice(2)).toEqual([
      { method: 'GET', url: cfList('send.oa.dev', 'MX') },
      { method: 'GET', url: cfList('send.oa.dev', 'TXT') },
      { method: 'GET', url: cfList('resend._domainkey.oa.dev', 'CNAME') },
      { method: 'POST', url: cfCreate, body: { type: 'CNAME', name: 'resend._domainkey.oa.dev', content: 'resend.dkim.amazonses.com', ttl: 1, comment: 'resend: DKIM' } },
      { method: 'GET', url: cfList('links.oa.dev', 'CNAME') },
      { method: 'POST', url: cfCreate, body: { type: 'CNAME', name: 'links.oa.dev', content: 'links1.resend-dns.com', ttl: 1, comment: 'resend: Tracking' } },
    ])
    expect(lines).toEqual([
      REUSED,
      ...RECORD_TABLE,
      'dns: = MX send.oa.dev already present (mx1) — skipping',
      'dns: = TXT send.oa.dev already present (txt1) — skipping',
      'dns: + CNAME resend._domainkey.oa.dev created (new-CNAME)',
      'dns: + CNAME links.oa.dev created (new-CNAME)',
      'done',
    ])
    expect(code).toBe(0)
  })

  it('is a no-op once everything is present', async () => {
    const all = {
      ...present,
      [`GET ${cfList('resend._domainkey.oa.dev', 'CNAME')}`]: { result: [cfRow('cn1', 'RESEND.dkim.amazonses.com.')] },
      [`GET ${cfList('links.oa.dev', 'CNAME')}`]: { result: [cfRow('cn2', 'links1.resend-dns.com')] },
    }
    const { calls } = await run(['--domain', DOMAIN, '--only', 'dns', '--zone-id', ZONE, '--run'], { routes: { ...existingDomain(), ...all } })
    expect(calls.map(c => c.method)).toEqual(['GET', 'GET', 'GET', 'GET', 'GET', 'GET'])
  })

  it('dry run: lists, prints the creates it would do, POSTs nothing', async () => {
    const { calls, lines } = await run(['--domain', DOMAIN, '--only', 'dns', '--zone-id', ZONE], { routes: { ...existingDomain(), ...present } })
    expect(calls.map(c => c.method)).toEqual(['GET', 'GET', 'GET', 'GET', 'GET', 'GET'])
    expect(lines).toEqual([
      REUSED,
      ...RECORD_TABLE,
      'dns: = MX send.oa.dev already present (mx1) — skipping',
      'dns: = TXT send.oa.dev already present (txt1) — skipping',
      `dns: [dry-run] would POST ${cfCreate} {"type":"CNAME","name":"resend._domainkey.oa.dev","content":"resend.dkim.amazonses.com","ttl":1,"comment":"resend: DKIM"}`,
      `dns: [dry-run] would POST ${cfCreate} {"type":"CNAME","name":"links.oa.dev","content":"links1.resend-dns.com","ttl":1,"comment":"resend: Tracking"}`,
      DRY_DONE,
    ])
  })

  it('--dmarc adds the monitor-only record when absent, and never replaces an existing policy', async () => {
    const base = { ...existingDomain(), ...present }
    const absent = { ...base, [`GET ${cfList('_dmarc.oa.dev', 'TXT')}`]: { result: [] } }
    const a = await run(['--domain', DOMAIN, '--only', 'dns', '--zone-id', ZONE, '--dmarc', '--run'], { routes: absent })
    expect(a.calls[a.calls.length - 1]).toEqual({
      method: 'POST',
      url: cfCreate,
      body: { type: 'TXT', name: '_dmarc.oa.dev', content: 'v=DMARC1; p=none;', ttl: 1, comment: 'resend: DMARC' },
    })
    expect(a.lines[a.lines.length - 2]).toBe('dns: + TXT _dmarc.oa.dev created (new-TXT)')

    const stricter = { ...base, [`GET ${cfList('_dmarc.oa.dev', 'TXT')}`]: { result: [cfRow('dm1', '"v=DMARC1; p=reject; rua=mailto:dmarc@oa.dev"')] } }
    const b = await run(['--domain', DOMAIN, '--only', 'dns', '--zone-id', ZONE, '--dmarc', '--run'], { routes: stricter })
    expect(b.calls[b.calls.length - 1]).toEqual({ method: 'GET', url: cfList('_dmarc.oa.dev', 'TXT') })
    expect(b.lines[b.lines.length - 2]).toBe('dns: = TXT _dmarc.oa.dev already present (dm1) — skipping')
  })
})

describe('verify', () => {
  it('skips an already-verified domain', async () => {
    const { calls, lines } = await run(['--domain', DOMAIN, '--only', 'verify', '--run'], { routes: existingDomain('verified') })
    expect(calls.map(c => c.method)).toEqual(['GET', 'GET'])
    expect(lines.slice(-2)).toEqual(['verify: oa.dev is already verified — skipping', 'done'])
  })

  it('dry run: prints the verify POST it would send', async () => {
    const { calls, lines } = await run(['--domain', DOMAIN, '--only', 'verify', '--wait', '60'], { routes: existingDomain() })
    expect(calls.map(c => c.method)).toEqual(['GET', 'GET'])
    expect(lines.slice(-2)).toEqual([
      `verify: [dry-run] would POST ${RESEND_API}/domains/dom-1/verify, then poll GET ${RESEND_API}/domains/dom-1 for up to 60s`,
      DRY_DONE,
    ])
  })

  it('kicks off verification and polls with exponential backoff within --wait', async () => {
    const statuses = ['pending', 'pending', 'pending', 'verified']
    const routes = {
      ...listRoutes(),
      [`GET ${RESEND_API}/domains/dom-1`]: () => domainJson(statuses.length > 1 ? statuses.shift() : statuses[0]),
      [`POST ${RESEND_API}/domains/dom-1/verify`]: { object: 'domain', id: 'dom-1' },
    }
    const { calls, lines, sleeps, code } = await run(['--domain', DOMAIN, '--only', 'verify', '--wait', '20', '--run'], { routes })
    expect(calls.map(c => `${c.method} ${c.url.slice(RESEND_API.length)}`)).toEqual([
      'GET /domains?limit=100',
      'GET /domains/dom-1',
      'POST /domains/dom-1/verify',
      'GET /domains/dom-1',
      'GET /domains/dom-1',
      'GET /domains/dom-1',
    ])
    expect(sleeps).toEqual([2, 4])
    expect(lines.slice(-5)).toEqual([
      'verify: requested for oa.dev',
      'verify: status pending; checking again in 2s',
      'verify: status pending; checking again in 4s',
      'verify: status verified',
      'done',
    ])
    expect(code).toBe(0)
  })

  it('default --wait 0 is a single check, and pending is not a failure', async () => {
    const routes = { ...existingDomain('pending'), [`POST ${RESEND_API}/domains/dom-1/verify`]: { object: 'domain', id: 'dom-1' } }
    const { sleeps, lines, code } = await run(['--domain', DOMAIN, '--only', 'verify', '--run'], { routes })
    expect(sleeps).toEqual([])
    expect(lines.slice(-3)).toEqual([
      'verify: status pending',
      'verify: DNS may still be propagating — re-run later with --only verify --wait 600',
      'done',
    ])
    expect(code).toBe(0)
  })

  it('exits 1 on failed', async () => {
    const routes = { ...existingDomain('failed'), [`POST ${RESEND_API}/domains/dom-1/verify`]: { object: 'domain', id: 'dom-1' } }
    const { lines, code } = await run(['--domain', DOMAIN, '--only', 'verify', '--run'], { routes })
    expect(lines.slice(-3)).toEqual([
      'verify: status failed',
      'verify: Resend could not find the records — check the zone, then re-run with --only verify',
      'done',
    ])
    expect(code).toBe(1)
  })
})

describe('secrets', () => {
  const argv = ['--domain', DOMAIN, '--only', 'secrets', '--from', 'Reports <noreply@oa.dev>', '--pages-project', 'myapp']

  it('pipes the key and MAIL_FROM to wrangler on stdin; the key is in neither argv nor output', async () => {
    const { calls, lines, execs, code } = await run([...argv, '--run'])
    expect(calls).toEqual([])
    expect(execs).toEqual([
      { cmd: 'npx', args: ['wrangler', 'pages', 'secret', 'put', 'RESEND_API_KEY', '--project-name', 'myapp'], input: `${KEY}\n` },
      { cmd: 'npx', args: ['wrangler', 'pages', 'secret', 'put', 'MAIL_FROM', '--project-name', 'myapp'], input: 'Reports <noreply@oa.dev>\n' },
    ])
    expect(lines).toEqual([
      'secrets: running: npx wrangler pages secret put RESEND_API_KEY --project-name myapp  # value on stdin (hidden)',
      'secrets: running: npx wrangler pages secret put MAIL_FROM --project-name myapp  # value on stdin: Reports <noreply@oa.dev>',
      'done',
    ])
    expect(lines.filter(l => l.includes(KEY))).toEqual([])
    expect(code).toBe(0)
  })

  it('targets a Worker with --worker', async () => {
    const { execs } = await run(['--domain', DOMAIN, '--only', 'secrets', '--from', 'noreply@oa.dev', '--worker', 'my-worker', '--run'])
    expect(execs.map(e => e.args)).toEqual([
      ['wrangler', 'secret', 'put', 'RESEND_API_KEY', '--name', 'my-worker'],
      ['wrangler', 'secret', 'put', 'MAIL_FROM', '--name', 'my-worker'],
    ])
  })

  it('dry run: prints the commands, runs nothing', async () => {
    const { execs, lines } = await run(argv)
    expect(execs).toEqual([])
    expect(lines).toEqual([
      'secrets: [dry-run] would run: npx wrangler pages secret put RESEND_API_KEY --project-name myapp  # value on stdin (hidden)',
      'secrets: [dry-run] would run: npx wrangler pages secret put MAIL_FROM --project-name myapp  # value on stdin: Reports <noreply@oa.dev>',
      DRY_DONE,
    ])
  })
})

describe('env tokens', () => {
  it('a missing token is a UsageError naming the variable, only for steps that need it', async () => {
    const noResend = await caughtAsync(run(['--domain', DOMAIN, '--only', 'create'], { env: { CLOUDFLARE_API_TOKEN: 'x' } }))
    expect(noResend instanceof UsageError).toBe(true)
    expect(noResend.message).toBe('RESEND_API_KEY is not set (export it in the environment; it is never read from argv)')

    const noCf = await caughtAsync(run(['--domain', DOMAIN, '--only', 'dns', '--zone-id', ZONE], { env: { RESEND_API_KEY: KEY } }))
    expect(noCf.message).toBe('CLOUDFLARE_API_TOKEN is not set (export it in the environment; it is never read from argv)')

    // `dns` reads the domain's records from Resend, so it needs that key too.
    const dnsNeedsResend = await caughtAsync(run(['--domain', DOMAIN, '--only', 'dns', '--zone-id', ZONE], { env: { CLOUDFLARE_API_TOKEN: 'x' } }))
    expect(dnsNeedsResend.message).toBe('RESEND_API_KEY is not set (export it in the environment; it is never read from argv)')

    // `secrets` alone never touches Cloudflare, so its token is not required.
    const { lines } = await run(['--domain', DOMAIN, '--only', 'secrets', '--from', 'a@oa.dev', '--worker', 'w'], { env: { RESEND_API_KEY: KEY } })
    expect(lines).toEqual([
      'secrets: [dry-run] would run: npx wrangler secret put RESEND_API_KEY --name w  # value on stdin (hidden)',
      'secrets: [dry-run] would run: npx wrangler secret put MAIL_FROM --name w  # value on stdin: a@oa.dev',
      DRY_DONE,
    ])
  })

  it('surfaces an API error with method, URL, status and the body head', async () => {
    const e = await caughtAsync(run(['--domain', DOMAIN, '--only', 'create'], { env: { RESEND_API_KEY: 'wrong' } }))
    expect(e instanceof UsageError).toBe(false)
    expect(e.message).toBe(`GET ${RESEND_API}/domains?limit=100 → 401: bad token`)
  })
})
