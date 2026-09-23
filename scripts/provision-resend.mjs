#!/usr/bin/env node
/**
 * Provision a Resend sending domain for `@open-athena/auth`'s email-code sign-in
 * (`emailCodeAuth` + the `resendEmail` adapter): create the domain, write the DNS
 * records it wants onto a Cloudflare zone, kick off verification, and store the two
 * secrets the reference mount reads (`RESEND_API_KEY`, `MAIL_FROM`).
 *
 * Unlike the Google OAuth client (`provision-oauth-client.mjs`), every step here has
 * an API, so nothing stays manual past "have a Resend account and a Cloudflare API
 * token" — see `specs/done/resend-provision.md`. Each step is idempotent: an existing
 * domain is reused, a DNS record already present with the same content is skipped, a
 * verified domain isn't re-verified. Re-running is safe and is the intended way to
 * finish the job once DNS has propagated.
 *
 * Default is a dry run: read-only GETs happen (so it can say exactly which records it
 * would create versus already exist), but no POST is sent and no command is run. Pass
 * `--run` to execute.
 *
 * Tokens are read from the environment only — `RESEND_API_KEY`, `CLOUDFLARE_API_TOKEN`
 * — never from argv, and the Resend key is never printed: the `secrets` step pipes it
 * to `wrangler` on stdin.
 *
 * Usage:
 *   RESEND_API_KEY=re_… CLOUDFLARE_API_TOKEN=… scripts/provision-resend.mjs \
 *     --domain oa.dev --zone-id <zone> --from noreply@oa.dev \
 *     --pages-project marin-gcs-usage [--dmarc] [--wait 600] [--run]
 */
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

/** The env-var names the reference mount (`examples/pages-functions`) reads. */
export const KEY_VAR = 'RESEND_API_KEY'
export const FROM_VAR = 'MAIL_FROM'
/** Where the Cloudflare token comes from. Needs `Zone:DNS:Edit` on the zone. */
export const CF_TOKEN_VAR = 'CLOUDFLARE_API_TOKEN'

export const RESEND_API = 'https://api.resend.com'
export const CF_API = 'https://api.cloudflare.com/client/v4'

/** The sub-steps, in the order they run. `--only` picks a subset. */
export const STEPS = ['create', 'dns', 'verify', 'secrets']

/** Resend's deployment regions (the create-domain reference lists exactly these). */
export const REGIONS = ['us-east-1', 'eu-west-1', 'sa-east-1', 'ap-northeast-1']

/** The DMARC record `--dmarc` adds: monitor-only, so it can't bounce anyone's mail. */
export const DMARC_VALUE = 'v=DMARC1; p=none;'

/** Verify-poll backoff: first delay, growth, cap (seconds). */
const POLL_FIRST_S = 2
const POLL_CAP_S = 30

/** A bad flag, value, or missing env var — reported to the user, not a stack trace. */
export class UsageError extends Error {}

const err = (...a) => console.error(...a)

/**
 * A Resend record name as a FQDN. SPF/DKIM names come back relative to the domain
 * (`send`, `resend._domainkey`); the Tracking CNAME comes back fully qualified
 * (`links.example.com`). Cloudflare wants the complete name either way.
 */
export function fqdn(name, domain) {
  const n = name.replace(/\.$/, '')
  if (n === domain || n.endsWith(`.${domain}`)) return n
  return `${n}.${domain}`
}

/**
 * The comparable form of a record value, so "already present" survives the two
 * providers' cosmetic differences: Resend quotes TXT values and dots CNAME targets;
 * Cloudflare may or may not echo either back.
 */
export function normalizeContent(type, value) {
  const v = String(value).trim()
  if (type === 'TXT') return v.replace(/^"(.*)"$/s, '$1')
  return v.replace(/\.$/, '').toLowerCase()
}

/**
 * The Cloudflare create body for one Resend record. `ttl: 1` is "automatic"; the
 * comment tags the record so it's recognizable (and grep-able) in the dashboard.
 */
export function dnsRecordBody(rec, domain) {
  const body = {
    type: rec.type,
    name: fqdn(rec.name, domain),
    content: rec.type === 'TXT' ? rec.value : rec.value.replace(/\.$/, ''),
    ttl: 1,
    comment: `resend: ${rec.record}`,
  }
  if (rec.priority !== undefined) body.priority = rec.priority
  return body
}

/** The record `--dmarc` adds, in the same shape Resend's records use. */
export function dmarcRecord(domain) {
  return { record: 'DMARC', name: `_dmarc.${domain}`, type: 'TXT', value: DMARC_VALUE }
}

/**
 * `--from` as a bare address, validated to be at the domain being provisioned.
 * Accepts `addr@domain` or `Name <addr@domain>`; returns the input unchanged (the
 * display name is part of what goes in `MAIL_FROM`).
 */
export function validateFrom(raw, domain) {
  const m = /^(?:[^<>]*<)?([^\s<>@]+)@([^\s<>@]+)>?$/.exec(raw.trim())
  if (!m) throw new UsageError(`--from must be an email address, got ${JSON.stringify(raw)}`)
  if (m[2].toLowerCase() !== domain.toLowerCase()) {
    throw new UsageError(`--from must be at ${domain}, got ${JSON.stringify(raw)}`)
  }
  return raw.trim()
}

/**
 * `wrangler` argv to store one secret for a Pages project or a Worker. The value is
 * NOT here — it is fed on stdin, so it never lands in argv, `ps`, or shell history.
 */
export function secretPutArgs(varName, { pagesProject, worker }) {
  if (pagesProject) return ['pages', 'secret', 'put', varName, '--project-name', pagesProject]
  return ['secret', 'put', varName, '--name', worker]
}

/** Render a command for display, single-quoting any arg that needs it. */
export function formatCommand(cmd, args) {
  const quote = a => (/^[A-Za-z0-9_./:@=-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)
  return [cmd, ...args].map(quote).join(' ')
}

/**
 * A fixed-width table of the records, one line each: record, type, FQDN, priority
 * (column present only if some record has one), value. Values are public DNS data.
 */
export function formatRecords(records, domain) {
  const withPriority = records.some(r => r.priority !== undefined)
  const rows = records.map(r => [
    r.record,
    r.type,
    fqdn(r.name, domain),
    ...(withPriority ? [r.priority === undefined ? '' : String(r.priority)] : []),
    r.value,
  ])
  const widths = rows[0] ? rows[0].slice(0, -1).map((_, i) => Math.max(...rows.map(r => r[i].length))) : []
  return rows.map(r => `  ${[...r.slice(0, -1).map((c, i) => c.padEnd(widths[i])), r[r.length - 1]].join('  ')}`)
}

/** The flags; throws `UsageError` on anything malformed or on a per-step requirement. */
export function parseArgs(argv) {
  const opts = {
    domain: null,
    zoneId: null,
    from: null,
    pagesProject: null,
    worker: null,
    region: 'us-east-1',
    returnPath: 'send',
    dmarc: false,
    wait: 0,
    only: STEPS,
    run: false,
    help: false,
  }
  const need = flag => {
    const v = argv[++i]
    if (v === undefined) throw new UsageError(`${flag} needs a value`)
    return v
  }
  let i = 0
  for (; i < argv.length; i++) {
    const a = argv[i]
    switch (a) {
      case '-h':
      case '--help':
        opts.help = true
        break
      case '--run':
        opts.run = true
        break
      case '--dmarc':
        opts.dmarc = true
        break
      case '--domain':
        opts.domain = need(a).toLowerCase().replace(/\.$/, '')
        break
      case '--zone-id':
        opts.zoneId = need(a)
        break
      case '--from':
        opts.from = need(a)
        break
      case '--pages-project':
        opts.pagesProject = need(a)
        break
      case '--worker':
        opts.worker = need(a)
        break
      case '--region': {
        const r = need(a)
        if (!REGIONS.includes(r)) throw new UsageError(`--region must be one of ${REGIONS.join(', ')}, got ${JSON.stringify(r)}`)
        opts.region = r
        break
      }
      case '--return-path':
        opts.returnPath = need(a)
        break
      case '--wait': {
        const w = Number(need(a))
        if (!Number.isInteger(w) || w < 0) throw new UsageError(`--wait must be a non-negative integer (seconds), got ${JSON.stringify(argv[i])}`)
        opts.wait = w
        break
      }
      case '--only': {
        const steps = need(a).split(',').map(s => s.trim()).filter(Boolean)
        const bad = steps.find(s => !STEPS.includes(s))
        if (bad !== undefined) throw new UsageError(`--only: unknown step ${JSON.stringify(bad)} (choose from ${STEPS.join(', ')})`)
        if (!steps.length) throw new UsageError('--only needs at least one step')
        opts.only = STEPS.filter(s => steps.includes(s))
        break
      }
      default:
        throw new UsageError(`unknown argument ${JSON.stringify(a)}`)
    }
  }
  if (opts.help) return opts
  if (!opts.domain) throw new UsageError('--domain is required')
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(opts.domain)) throw new UsageError(`--domain must be a bare domain name, got ${JSON.stringify(opts.domain)}`)
  if (opts.pagesProject && opts.worker) throw new UsageError('--pages-project and --worker are mutually exclusive')
  if (opts.only.includes('dns') && !opts.zoneId) throw new UsageError('--zone-id is required for the dns step')
  if (opts.only.includes('secrets')) {
    if (!opts.from) throw new UsageError('--from is required for the secrets step')
    if (!opts.pagesProject && !opts.worker) throw new UsageError('--pages-project or --worker is required for the secrets step')
  }
  if (opts.from) opts.from = validateFrom(opts.from, opts.domain)
  return opts
}

const HELP = `provision-resend — set up a Resend sending domain for @open-athena/auth's email-code sign-in

Required:
  --domain <name>           the sending domain, e.g. oa.dev

Per step:
  --zone-id <id>            Cloudflare zone the DNS records go in         (dns)
  --from <addr>             MAIL_FROM, e.g. noreply@oa.dev or 'App <noreply@oa.dev>'  (secrets)
  --pages-project <name>    Cloudflare Pages project to store the secrets in  (secrets)
  --worker <name>           …or a Worker, instead of a Pages project         (secrets)

Optional:
  --region <r>              Resend region: ${REGIONS.join(' | ')} (default us-east-1)
  --return-path <label>     Resend custom return-path subdomain (default send)
  --dmarc                   also add _dmarc.<domain> TXT "${DMARC_VALUE}" if absent
  --wait <seconds>          keep polling verification this long (default 0: one check)
  --only <steps>            comma-separated subset of: ${STEPS.join(', ')}
  --run                     actually create/write (default: dry run — GETs only, prints the plan)
  -h, --help                this help

Env:
  ${KEY_VAR}            Resend API key (full access — domains are account-scoped); also the value stored by the secrets step
  ${CF_TOKEN_VAR}      Cloudflare API token with Zone:DNS:Edit on the zone

Every step is idempotent; re-run after DNS propagates to finish verification.`

/** One JSON request; a non-2xx is an error carrying the body's first line. */
async function api(fetch, method, url, { token, body } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status}${text ? `: ${text.split('\n')[0].slice(0, 200)}` : ''}`)
  return text ? JSON.parse(text) : {}
}

/** Every Resend domain on the account, following the cursor. */
async function listDomains(fetch, token) {
  const all = []
  let after = null
  for (;;) {
    const url = `${RESEND_API}/domains?limit=100${after ? `&after=${encodeURIComponent(after)}` : ''}`
    const page = await api(fetch, 'GET', url, { token })
    all.push(...(page.data ?? []))
    if (!page.has_more || !all.length) return all
    after = all[all.length - 1].id
  }
}

/**
 * The whole flow. `deps` exist so tests can drive it without a network or a shell:
 * `env` (tokens), `fetch`, `exec(cmd, args, input)`, `err` (line sink), `sleep(s)`.
 */
export async function main(argv, deps = {}) {
  const {
    env = process.env,
    fetch = globalThis.fetch,
    exec = (cmd, args, input) => execFileSync(cmd, args, { stdio: ['pipe', 'inherit', 'inherit'], input }),
    err: out = err,
    sleep = s => new Promise(res => setTimeout(res, s * 1000)),
  } = deps

  const opts = parseArgs(argv)
  if (opts.help) {
    console.log(HELP)
    return 0
  }
  const dry = !opts.run
  const steps = opts.only
  const wants = s => steps.includes(s)
  const tag = dry ? '[dry-run] would' : ''
  const envVar = name => {
    const v = env[name]
    if (!v) throw new UsageError(`${name} is not set (export it in the environment; it is never read from argv)`)
    return v
  }
  // Every step talks to Resend (`dns` reads the domain's records; `secrets` stores
  // the key itself), so that token is unconditional; Cloudflare's only for `dns`.
  const resendKey = envVar(KEY_VAR)
  const cfToken = wants('dns') ? envVar(CF_TOKEN_VAR) : null
  const { domain } = opts

  // 1. Resolve (or create) the domain. `dns` and `verify` need its id/records too, so
  //    the lookup runs whenever any of the three is selected; only `create` may POST.
  let dom = null
  if (wants('create') || wants('dns') || wants('verify')) {
    const existing = (await listDomains(fetch, resendKey)).find(d => d.name.toLowerCase() === domain)
    if (existing) {
      dom = await api(fetch, 'GET', `${RESEND_API}/domains/${existing.id}`, { token: resendKey })
      out(`create: ${domain} already exists in Resend (id ${dom.id}, status ${dom.status}, region ${dom.region}) — reusing`)
    } else if (!wants('create')) {
      throw new UsageError(`${domain} is not registered in Resend; include create in --only (or drop --only)`)
    } else {
      const body = { name: domain, region: opts.region, custom_return_path: opts.returnPath }
      if (dry) {
        out(`create: ${tag} POST ${RESEND_API}/domains ${JSON.stringify(body)}`)
        out('create: records are minted on creation — re-run with --run (or --only create --run) to see them')
      } else {
        dom = await api(fetch, 'POST', `${RESEND_API}/domains`, { token: resendKey, body })
        out(`create: created ${domain} in Resend (id ${dom.id}, region ${dom.region})`)
      }
    }
    if (dom) {
      out(`create: ${domain} wants these records (${dom.records.length}):`)
      for (const line of formatRecords(dom.records, domain)) out(line)
    }
  }

  // 2. DNS: list-then-create per record, so a second run is a no-op.
  if (wants('dns')) {
    const records = [...(dom?.records ?? [])]
    if (opts.dmarc) records.push(dmarcRecord(domain))
    if (!records.length) out('dns: nothing to write yet (no domain records)')
    for (const rec of records) {
      const body = dnsRecordBody(rec, domain)
      const listUrl = `${CF_API}/zones/${opts.zoneId}/dns_records?name=${encodeURIComponent(body.name)}&type=${body.type}&per_page=100`
      const { result = [] } = await api(fetch, 'GET', listUrl, { token: cfToken })
      // DMARC is a policy: any existing one wins (never downgrade a `p=reject` to `p=none`).
      const present = rec.record === 'DMARC'
        ? result.find(r => normalizeContent('TXT', r.content).startsWith('v=DMARC1'))
        : result.find(r => normalizeContent(body.type, r.content) === normalizeContent(body.type, body.content))
      const label = `${body.type} ${body.name}`
      if (present) {
        out(`dns: = ${label} already present (${present.id}) — skipping`)
        continue
      }
      if (dry) {
        out(`dns: ${tag} POST ${CF_API}/zones/${opts.zoneId}/dns_records ${JSON.stringify(body)}`)
        continue
      }
      const created = await api(fetch, 'POST', `${CF_API}/zones/${opts.zoneId}/dns_records`, { token: cfToken, body })
      out(`dns: + ${label} created (${created.result.id})`)
    }
  }

  // 3. Verify: kick it off, then poll with backoff for as long as the caller allows.
  let code = 0
  if (wants('verify')) {
    if (!dom) {
      out('verify: nothing to verify yet (no domain)')
    } else if (dom.status === 'verified') {
      out(`verify: ${domain} is already verified — skipping`)
    } else if (dry) {
      out(`verify: ${tag} POST ${RESEND_API}/domains/${dom.id}/verify, then poll GET ${RESEND_API}/domains/${dom.id} for up to ${opts.wait}s`)
    } else {
      await api(fetch, 'POST', `${RESEND_API}/domains/${dom.id}/verify`, { token: resendKey })
      out(`verify: requested for ${domain}`)
      let waited = 0
      let delay = POLL_FIRST_S
      let status = (await api(fetch, 'GET', `${RESEND_API}/domains/${dom.id}`, { token: resendKey })).status
      while (status !== 'verified' && status !== 'failed' && waited + delay <= opts.wait) {
        out(`verify: status ${status}; checking again in ${delay}s`)
        await sleep(delay)
        waited += delay
        delay = Math.min(delay * 2, POLL_CAP_S)
        status = (await api(fetch, 'GET', `${RESEND_API}/domains/${dom.id}`, { token: resendKey })).status
      }
      out(`verify: status ${status}`)
      if (status === 'failed' || status === 'temporary_failure') {
        out('verify: Resend could not find the records — check the zone, then re-run with --only verify')
        code = 1
      } else if (status !== 'verified') {
        out('verify: DNS may still be propagating — re-run later with --only verify --wait 600')
      }
    }
  }

  // 4. Secrets: the key never appears in argv or output; wrangler reads it on stdin.
  if (wants('secrets')) {
    const target = { pagesProject: opts.pagesProject, worker: opts.worker }
    for (const [name, value] of [[KEY_VAR, resendKey], [FROM_VAR, opts.from]]) {
      const args = ['wrangler', ...secretPutArgs(name, target)]
      out(`secrets: ${dry ? `${tag} run` : 'running'}: ${formatCommand('npx', args)}  # value on stdin${name === KEY_VAR ? ' (hidden)' : `: ${value}`}`)
      if (!dry) exec('npx', args, `${value}\n`)
    }
  }

  out(dry ? 'dry run complete — nothing was created; add --run to apply' : 'done')
  return code
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then(code => process.exit(code))
    .catch(e => {
      err(e instanceof UsageError ? `error: ${e.message}\n\nrun with --help for usage` : e)
      process.exit(2)
    })
}
