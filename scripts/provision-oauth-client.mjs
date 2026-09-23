#!/usr/bin/env node
/**
 * Provision a per-app Google "Web application" OAuth client for `@open-athena/auth`'s
 * Google sign-in (the `oidc` adapter's redirect flow + the `GoogleOneTap` component).
 *
 * There is no API to create a classic Sign-in-with-Google client or read back its
 * secret — that one step is Cloud-Console-only (see `specs/done/oauth-client-iac.md`).
 * So this doesn't pretend to be `terraform apply`: it scripts the whole envelope
 * around the single manual click — orients gcloud, prints a deep link to the create
 * form pre-filled with the exact field values, then captures the pasted id/secret
 * into the app's secret store — turning "unintuitive console clicks" into "paste two
 * values when prompted".
 *
 * Default is a dry run: it prints every command it would run and the deep link, and
 * executes nothing. Pass `--run` to actually orient gcloud and write the secrets; even
 * then the client-create step stays manual (you paste the generated id/secret back).
 *
 * Usage:
 *   scripts/provision-oauth-client.mjs \
 *     --project oa-internal-450019 \
 *     --app-origin https://marin-gcs-usage.pages.dev \
 *     --redirect-uri https://marin-gcs-usage.pages.dev/auth/google/callback \
 *     --pages-project marin-gcs-usage [--run]
 */
import { execFileSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'

/** The env-var names auth's `oidc` adapter / `GoogleOneTap` read the client id/secret from
 * (matches the README's `env.GOOGLE_CLIENT_ID` / `env.GOOGLE_CLIENT_SECRET`). */
export const ID_VAR = 'GOOGLE_CLIENT_ID'
export const SECRET_VAR = 'GOOGLE_CLIENT_SECRET'

/** A bad flag or value — reported to the user, not a stack trace. */
export class UsageError extends Error {}

const err = (...a) => console.error(...a)

/**
 * A JS origin One Tap accepts: `https://host[:port]` (or `http://localhost[:port]`),
 * with no path, query, or fragment. A trailing slash is tolerated and normalized away.
 * Returns the bare origin.
 */
export function validateJsOrigin(raw) {
  let u
  try {
    u = new URL(raw)
  } catch {
    throw new UsageError(`--app-origin must be a URL, got ${JSON.stringify(raw)}`)
  }
  const isLocalhost = u.hostname === 'localhost' || u.hostname === '127.0.0.1'
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLocalhost)) {
    throw new UsageError(`--app-origin must be https:// (http:// only for localhost), got ${JSON.stringify(raw)}`)
  }
  if (u.pathname !== '/' || u.search || u.hash) {
    throw new UsageError(`--app-origin must be a bare origin with no path/query, got ${JSON.stringify(raw)}`)
  }
  return u.origin
}

/**
 * A redirect URI for the auth-code flow: `https://host/path` (or `http://localhost/path`).
 * Unlike the JS origin it must carry the callback path (e.g. `/auth/google/callback`).
 */
export function validateRedirectUri(raw) {
  let u
  try {
    u = new URL(raw)
  } catch {
    throw new UsageError(`--redirect-uri must be a URL, got ${JSON.stringify(raw)}`)
  }
  const isLocalhost = u.hostname === 'localhost' || u.hostname === '127.0.0.1'
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLocalhost)) {
    throw new UsageError(`--redirect-uri must be https:// (http:// only for localhost), got ${JSON.stringify(raw)}`)
  }
  if (u.pathname === '/' || u.pathname === '') {
    throw new UsageError(`--redirect-uri must include the callback path, got ${JSON.stringify(raw)}`)
  }
  return u.href
}

/** The project-scoped deep link to the Console's "Create OAuth client" form. */
export function consoleCreateUrl(project) {
  return `https://console.cloud.google.com/auth/clients/create?project=${encodeURIComponent(project)}`
}

/** `gcloud` argv to orient the CLI at the project (no mutation of cloud state). */
export function setProjectArgs(project) {
  return ['config', 'set', 'project', project]
}

/** `gcloud` argv to enable one API the project may lack. Basic sign-in needs none. */
export function enableServiceArgs(service, project) {
  return ['services', 'enable', service, '--project', project]
}

/**
 * `wrangler` argv to store one secret for a Pages project. The value is NOT here —
 * it is fed on stdin, so the secret never lands in argv, `ps`, or shell history.
 */
export function secretPutArgs(varName, pagesProject) {
  return ['pages', 'secret', 'put', varName, '--project-name', pagesProject]
}

/** Render a command for display, single-quoting any arg that needs it. */
export function formatCommand(cmd, args) {
  const quote = a => (/^[A-Za-z0-9_./:@=-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)
  return [cmd, ...args].map(quote).join(' ')
}

/** The two required flags plus optionals; throws `UsageError` on anything malformed. */
export function parseArgs(argv) {
  const opts = {
    project: null,
    appOrigin: null,
    redirectUris: [],
    pagesProject: null,
    enableServices: [],
    idVar: ID_VAR,
    secretVar: SECRET_VAR,
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
      case '--project':
        opts.project = need(a)
        break
      case '--app-origin':
        opts.appOrigin = validateJsOrigin(need(a))
        break
      case '--redirect-uri':
        opts.redirectUris.push(validateRedirectUri(need(a)))
        break
      case '--pages-project':
        opts.pagesProject = need(a)
        break
      case '--enable-service':
        opts.enableServices.push(need(a))
        break
      case '--id-var':
        opts.idVar = need(a)
        break
      case '--secret-var':
        opts.secretVar = need(a)
        break
      default:
        throw new UsageError(`unknown argument ${JSON.stringify(a)}`)
    }
  }
  if (!opts.help) {
    if (!opts.project) throw new UsageError('--project is required')
    if (!opts.appOrigin) throw new UsageError('--app-origin is required')
  }
  return opts
}

const HELP = `provision-oauth-client — set up a per-app Google OAuth client for @open-athena/auth

Required:
  --project <id>            GCP project the client lives in
  --app-origin <url>        the app's web origin (One Tap JS origin), https://host, no path

Optional:
  --redirect-uri <url>      auth-code callback URL, e.g. https://host/auth/google/callback (repeatable)
  --pages-project <name>    Cloudflare Pages project to store the secrets in (else the wrangler step is printed only)
  --enable-service <api>    a Google API to enable (repeatable; basic sign-in needs none)
  --id-var <name>           env var for the client id      (default ${ID_VAR})
  --secret-var <name>       env var for the client secret  (default ${SECRET_VAR})
  --run                     actually orient gcloud + write secrets (default: dry run, prints only)
  -h, --help                this help

One client per deployment — see specs/done/oauth-client-iac.md for why.`

/**
 * Prompt for the public client id (echoed) then the client secret (NOT echoed), on
 * one readline interface. Uses a buffered `line` queue rather than two `rl.question`
 * calls: with piped input the second question races the stream and drops the line, so
 * both prompts must share one persistent reader. The secret's characters are muted;
 * it is returned to the caller and never written anywhere.
 */
function captureClient(idVar, secretVar) {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY })
  let mute = false
  const passthrough = rl._writeToOutput?.bind(rl)
  rl._writeToOutput = s => {
    if (mute) rl.output.write(s.includes('\n') ? '\n' : '')
    else if (passthrough) passthrough(s)
    else rl.output.write(s)
  }
  const queued = []
  const waiting = []
  let closed = false
  rl.on('line', l => {
    const w = waiting.shift()
    if (w) w(l)
    else queued.push(l)
  })
  rl.on('close', () => {
    closed = true
    for (const w of waiting) w(null)
    waiting.length = 0
  })
  const nextLine = () =>
    new Promise(res => (queued.length ? res(queued.shift()) : closed ? res(null) : waiting.push(res)))
  return (async () => {
    process.stdout.write(`${idVar} (client id): `)
    const clientId = ((await nextLine()) ?? '').trim()
    process.stdout.write(`${process.stdin.isTTY ? '' : '\n'}${secretVar} (client secret, hidden): `)
    mute = true
    const clientSecret = ((await nextLine()) ?? '').trim()
    mute = false
    rl.close()
    return { clientId, clientSecret }
  })()
}

async function main(argv) {
  const opts = parseArgs(argv)
  if (opts.help) {
    console.log(HELP)
    return 0
  }
  const dry = !opts.run
  const tag = dry ? '[dry-run] would run:' : 'running:'
  const runOrShow = (cmd, args, stdin) => {
    err(`${tag} ${formatCommand(cmd, args)}`)
    if (!dry) execFileSync(cmd, args, { stdio: stdin === undefined ? 'inherit' : ['pipe', 'inherit', 'inherit'], input: stdin })
  }

  // 1. Orient gcloud (+ any explicitly-requested API enables; sign-in needs none).
  runOrShow('gcloud', setProjectArgs(opts.project))
  for (const svc of opts.enableServices) runOrShow('gcloud', enableServiceArgs(svc, opts.project))

  // 2. Consent screen — there is no API to create/query an External brand, so assert
  //    by instruction rather than pretend to check it.
  err('')
  err('Consent screen (once per project): APIs & Services → OAuth consent screen')
  err('  · User type: External   · Publishing status: In production (not Testing)')
  err('  · Scopes: none to add — openid/email/profile are non-sensitive, so no Google verification')
  err(`  · ${`https://console.cloud.google.com/auth/overview?project=${encodeURIComponent(opts.project)}`}`)

  // 3. The one manual gate: create the client. Print the deep link + exact field values.
  err('')
  err('Create the OAuth client (the one manual step):')
  err(`  1. open ${consoleCreateUrl(opts.project)}`)
  err('  2. Application type: Web application')
  err(`  3. Authorized JavaScript origins: ${opts.appOrigin}`)
  if (opts.redirectUris.length) {
    err(`  4. Authorized redirect URIs: ${opts.redirectUris.join('  ')}`)
  } else {
    err('  4. Authorized redirect URIs: (none — One Tap only; add the callback URL if you use the redirect flow)')
  }
  err('  5. Create, then paste the generated values below.')
  err('')

  // 4. Capture the pasted pair. The id is public (echoed); the secret is muted and only
  //    ever handed to wrangler on stdin — never printed, logged, or placed in argv.
  const { clientId, clientSecret } = await captureClient(opts.idVar, opts.secretVar)
  if (!clientId || !clientSecret) {
    err('no id/secret entered — nothing stored')
    return 1
  }
  err(`captured ${opts.idVar}=${clientId} (secret hidden, ${clientSecret.length} chars)`)

  // 5. Store the secrets. Without a Pages project we can only show the commands.
  err('')
  if (opts.pagesProject) {
    runOrShow('npx', ['wrangler', ...secretPutArgs(opts.idVar, opts.pagesProject)], clientId)
    runOrShow('npx', ['wrangler', ...secretPutArgs(opts.secretVar, opts.pagesProject)], clientSecret)
  } else {
    err('no --pages-project given; store the pair yourself, e.g.:')
    err(`  echo <id>     | npx ${formatCommand('wrangler', secretPutArgs(opts.idVar, '<pages-project>'))}`)
    err(`  echo <secret> | npx ${formatCommand('wrangler', secretPutArgs(opts.secretVar, '<pages-project>'))}`)
  }
  err('')
  err(`done. ${opts.idVar} is public (safe to expose to the One Tap component); ${opts.secretVar} is server-only.`)
  return 0
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
