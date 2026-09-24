#!/usr/bin/env node
/**
 * Prove a group-sync service account works before wiring it into an app, and
 * (optionally) land its key in the app's secret store in the same breath — so
 * the key exists exactly once, on stdin, never on disk:
 *
 *   gcloud iam service-accounts keys create /dev/stdout --iam-account <sa> \
 *     | (cd <app> && direnv exec . node $oa/auth/scripts/verify-group-sync.mjs \
 *          --group board@example.org --store-pages <pages-project>)
 *
 * Reads the SA key JSON on stdin, mints a token (`googleAccessToken`), lists
 * each `--group` (`listGroupMembers`), prints the members, and only then — if
 * `--store-pages <project>` / `--store-worker <name>` is given — pipes the
 * same key to `wrangler … secret put GOOGLE_SA_KEY`. A failed listing exits
 * non-zero and stores nothing, so a mis-provisioned SA never becomes a secret.
 *
 * Imports the built adapter, so run `pnpm build` in the auth repo first.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const KEY_VAR = 'GOOGLE_SA_KEY'
export const APIS = ['directory', 'cloud-identity']

/** A bad flag or input — reported to the user, not a stack trace. */
export class UsageError extends Error {}

const err = (...a) => console.error(...a)

export function parseArgs(argv) {
  const opts = { groups: [], api: 'cloud-identity', subject: null, pagesProject: null, worker: null, help: false }
  let i = 0
  const need = flag => {
    const v = argv[++i]
    if (v === undefined) throw new UsageError(`${flag} needs a value`)
    return v
  }
  for (; i < argv.length; i++) {
    const a = argv[i]
    switch (a) {
      case '-h':
      case '--help':
        opts.help = true
        break
      case '--group':
        opts.groups.push(need(a).toLowerCase())
        break
      case '--api': {
        const v = need(a)
        if (!APIS.includes(v)) throw new UsageError(`--api must be one of ${APIS.join(', ')}, got ${JSON.stringify(v)}`)
        opts.api = v
        break
      }
      case '--subject':
        opts.subject = need(a)
        break
      case '--store-pages':
        opts.pagesProject = need(a)
        break
      case '--store-worker':
        opts.worker = need(a)
        break
      default:
        throw new UsageError(`unknown argument ${JSON.stringify(a)}`)
    }
  }
  if (opts.help) return opts
  if (!opts.groups.length) throw new UsageError('at least one --group is required')
  if (opts.pagesProject && opts.worker) throw new UsageError('--store-pages and --store-worker are mutually exclusive')
  return opts
}

/** `wrangler` argv to store the key for a Pages project or a Worker (value on stdin). */
export function secretPutArgs({ pagesProject, worker }) {
  return pagesProject
    ? ['pages', 'secret', 'put', KEY_VAR, '--project-name', pagesProject]
    : ['secret', 'put', KEY_VAR, '--name', worker]
}

const HELP = `verify-group-sync — list a Workspace group as a service account, then (optionally) store its key

Reads the service-account key JSON on stdin.

  --group <email>           group to list (repeatable; required)
  --api <cloud-identity|directory>   which Google API to read (default cloud-identity; directory needs an admin-role/DWD SA)
  --subject <admin@…>       domain-wide delegation only: the admin to impersonate
  --store-pages <project>   on success, pipe the key to: wrangler pages secret put ${KEY_VAR} --project-name <project>
  --store-worker <name>     …or: wrangler secret put ${KEY_VAR} --name <name>
  -h, --help                this help`

async function readStdin(stdin) {
  const chunks = []
  for await (const c of stdin) chunks.push(typeof c === 'string' ? Buffer.from(c) : c)
  return Buffer.concat(chunks).toString('utf8')
}

export async function main(argv, deps = {}) {
  const {
    stdin = process.stdin,
    exec = (cmd, args, input) => execFileSync(cmd, args, { stdio: ['pipe', 'inherit', 'inherit'], input }),
    err: out = err,
    adapter = null,
  } = deps
  const opts = parseArgs(argv)
  if (opts.help) {
    console.log(HELP)
    return 0
  }
  const { googleAccessToken, listGroupMembers, DIRECTORY_SCOPE, CLOUD_IDENTITY_SCOPE } = adapter ?? (await loadAdapter())

  const key = (await readStdin(stdin)).trim()
  if (!key) throw new UsageError('expected the service-account key JSON on stdin')

  const scope = opts.api === 'directory' ? DIRECTORY_SCOPE : CLOUD_IDENTITY_SCOPE
  const { accessToken, clientEmail } = await googleAccessToken({ key, scopes: [scope], subject: opts.subject ?? undefined })
  out(`token: ok (${clientEmail})`)
  for (const group of opts.groups) {
    const members = await listGroupMembers(group, { token: accessToken, api: opts.api })
    out(`${group}: ${members.length} member${members.length === 1 ? '' : 's'}`)
    for (const m of members) out(`  ${m}`)
  }

  if (opts.pagesProject || opts.worker) {
    const args = ['wrangler', ...secretPutArgs(opts)]
    out(`storing: npx ${args.join(' ')}  # key on stdin (hidden)`)
    exec('npx', args, key)
  }
  return 0
}

async function loadAdapter() {
  const url = new URL('../dist/adapters/google-directory.js', import.meta.url)
  if (!existsSync(url)) throw new UsageError('dist/ is missing — run `pnpm build` in the auth repo first')
  return import(url.href)
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
