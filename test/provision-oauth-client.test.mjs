/** The pure, side-effect-free surface of the OAuth-client provisioning CLI. */
import { describe, expect, it } from 'vitest'
import {
  ID_VAR,
  SECRET_VAR,
  UsageError,
  consoleCreateUrl,
  enableServiceArgs,
  formatCommand,
  missingFromClient,
  parseClientJson,
  parseArgs,
  secretPutArgs,
  upsertDevVars,
  validateJsOrigin,
  validateRedirectUri,
} from '../scripts/provision-oauth-client.mjs'

/** Run `fn`, return the thrown error (or null) — so a message can be asserted exactly. */
const caught = fn => {
  try {
    fn()
    return null
  } catch (e) {
    return e
  }
}

describe('validateJsOrigin', () => {
  it('returns the bare origin, normalizing a trailing slash away', () => {
    expect(validateJsOrigin('https://x.pages.dev')).toBe('https://x.pages.dev')
    expect(validateJsOrigin('https://x.pages.dev/')).toBe('https://x.pages.dev')
    expect(validateJsOrigin('https://host:8443')).toBe('https://host:8443')
  })

  it('allows http only for localhost (One Tap dev)', () => {
    expect(validateJsOrigin('http://localhost:4187')).toBe('http://localhost:4187')
    expect(validateJsOrigin('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000')
  })

  it('rejects http on a real host, a path, and a query/fragment', () => {
    expect(caught(() => validateJsOrigin('http://evil.com')).message).toBe(
      '--app-origin must be https:// (http:// only for localhost), got "http://evil.com"',
    )
    expect(caught(() => validateJsOrigin('https://x.com/app')).message).toBe(
      '--app-origin must be a bare origin with no path/query, got "https://x.com/app"',
    )
    expect(caught(() => validateJsOrigin('https://x.com?a=1')).message).toBe(
      '--app-origin must be a bare origin with no path/query, got "https://x.com?a=1"',
    )
    expect(caught(() => validateJsOrigin('not a url')) instanceof UsageError).toBe(true)
  })
})

describe('validateRedirectUri', () => {
  it('accepts an https callback URL with a path', () => {
    expect(validateRedirectUri('https://x.pages.dev/auth/google/callback')).toBe(
      'https://x.pages.dev/auth/google/callback',
    )
  })

  it('rejects a bare origin (no callback path) and non-https on a real host', () => {
    expect(caught(() => validateRedirectUri('https://x.pages.dev')).message).toBe(
      '--redirect-uri must include the callback path, got "https://x.pages.dev"',
    )
    expect(caught(() => validateRedirectUri('http://x.com/cb')).message).toBe(
      '--redirect-uri must be https:// (http:// only for localhost), got "http://x.com/cb"',
    )
  })
})

describe('command + URL builders', () => {
  it('builds the project-scoped create-form deep link', () => {
    expect(consoleCreateUrl('oa-internal-450019')).toBe(
      'https://console.cloud.google.com/auth/clients/create?project=oa-internal-450019',
    )
  })

  it('builds the exact gcloud/wrangler argv', () => {
    expect(enableServiceArgs('iap.googleapis.com', 'p')).toEqual(['services', 'enable', 'iap.googleapis.com', '--project', 'p'])
    expect(secretPutArgs(ID_VAR, 'myapp')).toEqual(['pages', 'secret', 'put', 'GOOGLE_CLIENT_ID', '--project-name', 'myapp'])
  })

  it('renders a command, quoting only args that need it', () => {
    expect(formatCommand('gcloud', enableServiceArgs('x.googleapis.com', 'p'))).toBe('gcloud services enable x.googleapis.com --project p')
    expect(formatCommand('npx', ['wrangler', ...secretPutArgs(SECRET_VAR, 'my app')])).toBe(
      "npx wrangler pages secret put GOOGLE_CLIENT_SECRET --project-name 'my app'",
    )
  })
})

describe('parseArgs', () => {
  it('parses the full flag set', () => {
    expect(
      parseArgs([
        '--project', 'p',
        '--app-origin', 'https://x.pages.dev/',
        '--app-origin', 'http://localhost:4187',
        '--redirect-uri', 'https://x.pages.dev/auth/google/callback',
        '--pages-project', 'myapp',
        '--wrangler', 'scripts/oa-wrangler.sh',
        '--from-json', 'client.json',
        '--dev-vars', '.dev.vars',
        '--enable-service', 'people.googleapis.com',
        '--run',
      ]),
    ).toEqual({
      project: 'p',
      appOrigins: ['https://x.pages.dev', 'http://localhost:4187'],
      redirectUris: ['https://x.pages.dev/auth/google/callback'],
      pagesProject: 'myapp',
      wrangler: 'scripts/oa-wrangler.sh',
      fromJson: 'client.json',
      devVars: '.dev.vars',
      enableServices: ['people.googleapis.com'],
      idVar: ID_VAR,
      secretVar: SECRET_VAR,
      run: true,
      help: false,
    })
  })

  it('defaults optionals and stays a dry run', () => {
    const o = parseArgs(['--project', 'p', '--app-origin', 'https://x.pages.dev'])
    expect([o.run, o.redirectUris, o.pagesProject, o.wrangler, o.fromJson, o.devVars, o.idVar, o.secretVar]).toEqual([
      false, [], null, 'npx wrangler', null, null, ID_VAR, SECRET_VAR,
    ])
  })

  it('requires --project and --app-origin, and rejects unknown/dangling flags', () => {
    expect(caught(() => parseArgs(['--app-origin', 'https://x.com'])).message).toBe('--project is required')
    expect(caught(() => parseArgs(['--project', 'p'])).message).toBe('--app-origin is required')
    expect(caught(() => parseArgs(['--nope'])).message).toBe('unknown argument "--nope"')
    expect(caught(() => parseArgs(['--project'])).message).toBe('--project needs a value')
  })

  it('needs neither --project nor --app-origin with --from-json (the client knows both)', () => {
    expect(parseArgs(['--from-json', 'c.json']).fromJson).toBe('c.json')
  })

  it('skips required-flag checks under --help', () => {
    expect(parseArgs(['--help']).help).toBe(true)
  })
})

const CLIENT_JSON = JSON.stringify({
  web: {
    client_id: 'id-123.apps.googleusercontent.com',
    project_id: 'oa-auth-509611',
    client_secret: 'shh',
    javascript_origins: ['https://auth.oa.dev', 'http://localhost:4187'],
    redirect_uris: ['https://auth.oa.dev/auth/google/callback'],
  },
})

describe('parseClientJson', () => {
  it("reads a Web client's id, secret, project, origins and redirect URIs", () => {
    expect(parseClientJson(CLIENT_JSON)).toEqual({
      project: 'oa-auth-509611',
      clientId: 'id-123.apps.googleusercontent.com',
      clientSecret: 'shh',
      origins: ['https://auth.oa.dev', 'http://localhost:4187'],
      redirectUris: ['https://auth.oa.dev/auth/google/callback'],
    })
  })

  it('rejects a non-Web client (e.g. Desktop, keyed "installed")', () => {
    const e = caught(() => parseClientJson(JSON.stringify({ installed: { client_id: 'x' } })))
    expect([e instanceof UsageError, e.message]).toEqual([true, 'client JSON has no "web" key — create a "Web application" client'])
  })
})

describe('missingFromClient', () => {
  const client = parseClientJson(CLIENT_JSON)

  it('is empty when the client lists everything asked for', () => {
    expect(
      missingFromClient(client, { appOrigins: ['https://auth.oa.dev'], redirectUris: ['https://auth.oa.dev/auth/google/callback'] }),
    ).toEqual([])
  })

  it('names each origin / redirect URI the client lacks', () => {
    expect(
      missingFromClient(client, {
        appOrigins: ['https://auth.oa.dev', 'https://m3.tail4a3a97.ts.net'],
        redirectUris: ['http://localhost:4187/auth/google/callback'],
      }),
    ).toEqual(['origin https://m3.tail4a3a97.ts.net', 'redirect URI http://localhost:4187/auth/google/callback'])
  })
})

describe('upsertDevVars', () => {
  it('appends to an empty file', () => {
    expect(upsertDevVars('', { A: '1', B: '2' })).toBe('A=1\nB=2\n')
  })

  it('replaces existing lines in place and keeps the others', () => {
    expect(upsertDevVars('SESSION_SECRET=s\nA=old\n', { A: 'new', B: '2' })).toBe('SESSION_SECRET=s\nA=new\nB=2\n')
  })
})
