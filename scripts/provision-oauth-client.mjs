#!/usr/bin/env node
/**
 * Provision a per-app Google "Web application" OAuth client for `@open-athena/auth`'s
 * Google sign-in (the `oidc` adapter's redirect flow + the `GoogleOneTap` component).
 *
 * There is no API to create a classic Sign-in-with-Google client or read back its
 * secret — that one step is Cloud-Console-only (see `specs/done/oauth-client-iac.md`).
 * So this doesn't pretend to be `terraform apply`: it scripts the whole envelope
 * around the single manual click — prints a deep link to the create form with the
 * exact field values, then stores the generated id/secret in the app's secret store
 * (and optionally a local `.dev.vars`).
 *
 * The id/secret come either from the JSON the Console offers after Create
 * ("Download JSON", `--from-json`, which is also checked against the origins and
 * redirect URIs you pass), or pasted at a prompt.
 *
 * Default is a dry run: it prints every command it would run, and writes nothing.
 * Pass `--run` to write the secrets. It never touches gcloud's default config.
 *
 * Usage:
 *   scripts/provision-oauth-client.mjs \
 *     --project oa-auth-509611 \
 *     --app-origin https://auth.oa.dev --app-origin http://localhost:4187 \
 *     --redirect-uri https://auth.oa.dev/auth/google/callback \
 *     --pages-project oa-auth-demo --wrangler demo/scripts/oa-wrangler.sh \
 *     --from-json client_secret_….json --dev-vars demo/.dev.vars [--run]
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
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

/**
 * The fields of the client JSON the Console offers after Create ("Download JSON").
 * Only a "Web application" client (top-level `web` key) serves the redirect flow and
 * One Tap.
 */
export function parseClientJson(text) {
  const web = JSON.parse(text).web
  if (!web) throw new UsageError('client JSON has no "web" key — create a "Web application" client')
  return {
    project: web.project_id,
    clientId: web.client_id,
    clientSecret: web.client_secret,
    origins: web.javascript_origins ?? [],
    redirectUris: web.redirect_uris ?? [],
  }
}

/** Origins / redirect URIs asked for that the created client doesn't list (a typo in the form, usually). */
export function missingFromClient(client, { appOrigins, redirectUris }) {
  return [
    ...appOrigins.filter(o => !client.origins.includes(o)).map(o => `origin ${o}`),
    ...redirectUris.filter(u => !client.redirectUris.includes(u)).map(u => `redirect URI ${u}`),
  ]
}

/**
 * Set `name=value` lines in a `.dev.vars` (dotenv) text: replace an existing line for
 * each name, append the rest, leave every other line alone.
 */
export function upsertDevVars(text, entries) {
  const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n')
  for (const [name, value] of Object.entries(entries)) {
    const line = `${name}=${value}`
    const i = lines.findIndex(l => l.startsWith(`${name}=`))
    if (i === -1) lines.push(line)
    else lines[i] = line
  }
  return `${lines.join('\n')}\n`
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
    appOrigins: [],
    redirectUris: [],
    pagesProject: null,
    wrangler: 'npx wrangler',
    fromJson: null,
    devVars: null,
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
        opts.appOrigins.push(validateJsOrigin(need(a)))
        break
      case '--redirect-uri':
        opts.redirectUris.push(validateRedirectUri(need(a)))
        break
      case '--pages-project':
        opts.pagesProject = need(a)
        break
      case '--wrangler':
        opts.wrangler = need(a)
        break
      case '--from-json':
        opts.fromJson = need(a)
        break
      case '--dev-vars':
        opts.devVars = need(a)
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
  // With --from-json, the created client already knows its project and origins.
  if (!opts.help && !opts.fromJson) {
    if (!opts.project) throw new UsageError('--project is required')
    if (!opts.appOrigins.length) throw new UsageError('--app-origin is required')
  }
  return opts
}

const HELP = `provision-oauth-client — set up a per-app Google OAuth client for @open-athena/auth

Required (unless --from-json):
  --project <id>            GCP project the client lives in
  --app-origin <url>        a web origin (One Tap JS origin), https://host[:port], no path (repeatable)

Optional:
  --redirect-uri <url>      auth-code callback URL, e.g. https://host/auth/google/callback (repeatable)
  --from-json <path>        the client JSON from the Console's "Download JSON" (else prompt for id/secret);
                            the origins/redirect URIs above are checked against it
  --pages-project <name>    Cloudflare Pages project to store the secrets in (else the wrangler step is printed only)
  --wrangler <cmd>          how to invoke wrangler (default "npx wrangler"; e.g. an account-pinning wrapper)
  --dev-vars <path>         also set both vars in this local .dev.vars (git-ignored!)
  --enable-service <api>    a Google API to enable (repeatable; basic sign-in needs none)
  --id-var <name>           env var for the client id      (default ${ID_VAR})
  --secret-var <name>       env var for the client secret  (default ${SECRET_VAR})
  --run                     actually write secrets (default: dry run, prints only)
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

  // 1. Any explicitly-requested API enables (sign-in needs none). gcloud's default
  //    config is never touched: every command names its project.
  const project = opts.project ?? (opts.fromJson && parseClientJson(readFileSync(opts.fromJson, 'utf8')).project)
  for (const svc of opts.enableServices) runOrShow('gcloud', enableServiceArgs(svc, project))

  let clientId, clientSecret
  if (opts.fromJson) {
    // 2a. The client already exists: read it, and check it has what was asked for.
    const client = parseClientJson(readFileSync(opts.fromJson, 'utf8'))
    const missing = missingFromClient(client, opts)
    if (missing.length) {
      err(`the client in ${opts.fromJson} is missing:`)
      for (const m of missing) err(`  ${m}`)
      err(`add them at https://console.cloud.google.com/auth/clients/${client.clientId}?project=${encodeURIComponent(client.project)}`)
      return 1
    }
    ;({ clientId, clientSecret } = client)
    err(`read ${opts.idVar}=${clientId} from ${opts.fromJson} (project ${client.project}; ${client.origins.length} origins, ${client.redirectUris.length} redirect URIs)`)
  } else {
    // 2b. Consent screen — there is no API to create/query an External brand, so assert
    //     by instruction rather than pretend to check it.
    err('')
    err('Consent screen (once per project): Google Auth Platform → Branding / Audience')
    err('  · User type: External   · Publishing status: In production (not Testing)')
    err('  · Branding: a privacy policy link (Publish stays disabled without one) and the authorized domains')
    err('  · Scopes: none to add — openid/email/profile are non-sensitive, so no Google verification')
    err(`  · ${`https://console.cloud.google.com/auth/overview?project=${encodeURIComponent(project)}`}`)

    // 3. The one manual gate: create the client. Print the deep link + exact field values.
    err('')
    err('Create the OAuth client (the one manual step):')
    err(`  1. open ${consoleCreateUrl(project)}`)
    err('  2. Application type: Web application')
    err(`  3. Authorized JavaScript origins: ${opts.appOrigins.join('  ')}`)
    if (opts.redirectUris.length) {
      err(`  4. Authorized redirect URIs: ${opts.redirectUris.join('  ')}`)
    } else {
      err('  4. Authorized redirect URIs: (none — One Tap only; add the callback URL if you use the redirect flow)')
    }
    err('  5. Create, then paste the generated values below (or re-run with --from-json <downloaded JSON>).')
    err('')

    // 4. Capture the pasted pair. The id is public (echoed); the secret is muted and only
    //    ever handed to wrangler on stdin — never printed, logged, or placed in argv.
    ;({ clientId, clientSecret } = await captureClient(opts.idVar, opts.secretVar))
    if (!clientId || !clientSecret) {
      err('no id/secret entered — nothing stored')
      return 1
    }
    err(`captured ${opts.idVar}=${clientId} (secret hidden, ${clientSecret.length} chars)`)
  }

  // 5. Store the secrets. Without a Pages project we can only show the commands.
  err('')
  const [wcmd, ...wargs] = opts.wrangler.split(/\s+/)
  if (opts.pagesProject) {
    runOrShow(wcmd, [...wargs, ...secretPutArgs(opts.idVar, opts.pagesProject)], clientId)
    runOrShow(wcmd, [...wargs, ...secretPutArgs(opts.secretVar, opts.pagesProject)], clientSecret)
  } else {
    err('no --pages-project given; store the pair yourself, e.g.:')
    err(`  printf %s <id>     | ${formatCommand(wcmd, [...wargs, ...secretPutArgs(opts.idVar, '<pages-project>')])}`)
    err(`  printf %s <secret> | ${formatCommand(wcmd, [...wargs, ...secretPutArgs(opts.secretVar, '<pages-project>')])}`)
  }
  if (opts.devVars) {
    err(`${dry ? '[dry-run] would set' : 'setting'} ${opts.idVar}, ${opts.secretVar} in ${opts.devVars}`)
    if (!dry) {
      const before = existsSync(opts.devVars) ? readFileSync(opts.devVars, 'utf8') : ''
      writeFileSync(opts.devVars, upsertDevVars(before, { [opts.idVar]: clientId, [opts.secretVar]: clientSecret }), { mode: 0o600 })
    }
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
