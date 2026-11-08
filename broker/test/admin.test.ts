/**
 * `/admin` over the real gate, registry (SQLite behind the D1 shim) and
 * provider, plus `oa-client.mjs`'s SQL run against the same tables.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { d1ClientRegistry, d1ProviderStore } from '../../src/adapters/d1-provider.js'
import { d1AuditSink, d1GrantStore } from '../../src/adapters/d1.js'
import { createGate, domainPolicy } from '../../src/index.js'
import { clientLookup, generateSigningKey, hashClientSecret, oidcProviderRoutes, type SigningJwk } from '../../src/provider/index.js'
import { testDbRaw } from '../../test/d1-shim.js'
import { createSql, existsSql, lit, listSql, rotateSql, setCallbacksSql, setDisabledSql } from '../scripts/oa-client.mjs'
import { adminRoutes, parseAdmins } from '../src/admin.js'

const ORIGIN = 'https://login.test'
const ADMIN = 'admin@openathena.ai'
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
const CB = 'https://jobs.oa.dev/auth/oa/callback'

let KEY: SigningJwk
beforeAll(async () => {
  KEY = await generateSigningKey('k1')
})

function setup() {
  const { db, raw } = testDbRaw(['provider'])
  const gate = createGate({
    store: d1GrantStore(db),
    audit: d1AuditSink(db),
    secret: 'test-secret',
    policy: domainPolicy(['openathena.ai'], ['member']),
  })
  const registry = d1ClientRegistry(db)
  const admin = adminRoutes({
    gate,
    registry,
    staticClients: [{ id: 'in-code', secretHash: 'x', redirectUris: ['https://code.oa.dev/cb'] }],
    admins: parseAdmins(` ${ADMIN.toUpperCase()} , `),
    redirectDomains: ['oa.dev'],
    signInPath: '/signin-here',
  })
  const provider = oidcProviderRoutes({
    gate,
    issuer: ORIGIN,
    clients: [],
    lookupClient: clientLookup(registry),
    keys: [KEY],
    store: d1ProviderStore(db),
    subjectSecret: 's',
    loginUrl: '/signin',
  })
  const cookieFor = async (email: string) => {
    const r = await gate.signIn(email, new Request(ORIGIN))
    return r!.cookies.map(c => c.split(';')[0]).join('; ')
  }
  const post = async (path: string, fields: Record<string, string>, cookie: string, origin: string | null = ORIGIN) =>
    (await admin(
      new Request(`${ORIGIN}${path}`, {
        method: 'POST',
        headers: { cookie, ...(origin ? { origin } : {}) },
        body: new URLSearchParams(fields),
      }),
    ))!
  const get = async (cookie: string) => (await admin(new Request(`${ORIGIN}/admin`, { headers: { cookie } })))!
  /** What `/authorize` says to this client and callback, before anyone is signed in. */
  const authorize = async (id: string, uri: string) => {
    const q = new URLSearchParams({ client_id: id, redirect_uri: uri, response_type: 'code', scope: 'openid', code_challenge: CHALLENGE, code_challenge_method: 'S256' })
    return (await provider(new Request(`${ORIGIN}/oidc/authorize?${q}`)))!.status
  }
  return { raw, registry, admin, cookieFor, post, get, authorize }
}

const secretOf = (html: string) => /<code id="secret">([^<]+)<\/code>/.exec(html)?.[1] ?? null
const NEW = { id: 'oa-jobs', name: 'Jobs', redirects: CB, postLogouts: '' }

describe('who gets in', () => {
  it('renders compact app rows with separate collapsed editors', async () => {
    const { get, cookieFor, registry } = setup()
    await registry.create({ id: 'oa-jobs', name: 'Job descriptions', secretHash: 'test-only-hash', redirectUris: [CB] }, ADMIN)
    await registry.create({ id: 'disky-gcs-dev', name: 'GCS usage (dev)', secretHash: 'test-only-hash', redirectUris: ['https://dev.gcs.oa.dev/auth/oa/callback'] }, ADMIN)
    const html = await (await get(await cookieFor(ADMIN))).text()
    const headings = [...html.matchAll(/<th scope="col">([^<]+)<\/th>/g)].map(m => m[1])
    const editors = [...html.matchAll(/<tr id="([^"]+)" class="app-editor"( hidden)?>/g)].map(m => ({ id: m[1], hidden: m[2] === ' hidden' }))
    expect(headings).toEqual(['App', 'Callbacks', 'Status', 'Actions'])
    expect(editors).toEqual([{ id: 'edit-disky-gcs-dev', hidden: true }, { id: 'edit-oa-jobs', hidden: true }])
    expect([...html.matchAll(/<span class="app-name">([^<]+)<\/span>/g)].map(m => m[1])).toEqual(['GCS usage (dev)', 'Job descriptions'])
    mkdirSync('tmp/broker-preview', { recursive: true })
    writeFileSync('tmp/broker-preview/index.html', html)
  })
  it('sends someone not signed in to sign in', async () => {
    const { admin } = setup()
    const res = (await admin(new Request(`${ORIGIN}/admin`)))!
    expect([res.status, res.headers.get('location')]).toEqual([302, '/signin-here'])
  })

  it('refuses a Workspace member who is not an admin, for reads and writes', async () => {
    const { get, post, cookieFor, registry } = setup()
    const cookie = await cookieFor('someone@openathena.ai')
    expect((await get(cookie)).status).toBe(403)
    expect((await post('/admin/clients', NEW, cookie)).status).toBe(403)
    expect(await registry.list()).toEqual([])
  })

  it('admits an admin, however the address is cased in config', async () => {
    const { get, cookieFor } = setup()
    expect((await get(await cookieFor(ADMIN))).status).toBe(200)
  })

  it.each([['https://evil.test'], [null]])('refuses a POST from origin %s', async origin => {
    const { post, cookieFor, registry } = setup()
    expect((await post('/admin/clients', NEW, await cookieFor(ADMIN), origin)).status).toBe(403)
    expect(await registry.list()).toEqual([])
  })

  it('leaves other paths to the rest of the broker', async () => {
    const { admin } = setup()
    expect(await admin(new Request(`${ORIGIN}/administrator`))).toBe(null)
  })
})

describe('creating an app', () => {
  it('shows the secret once, stores only its hash, and the provider then accepts the app', async () => {
    const { post, get, cookieFor, registry, authorize } = setup()
    const cookie = await cookieFor(ADMIN)
    expect(await authorize('oa-jobs', CB)).toBe(400)

    const res = await post('/admin/clients', NEW, cookie)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const secret = secretOf(await res.text())!
    expect(secret).toMatch(/^[\w-]{43}$/)

    const stored = (await registry.get('oa-jobs'))!
    expect(stored.secretHash).toBe(await hashClientSecret(secret))
    expect([stored.name, stored.redirectUris, stored.createdBy, stored.disabledAt]).toEqual(['Jobs', [CB], ADMIN, null])
    expect(await authorize('oa-jobs', CB)).toBe(302)
    expect(await authorize('oa-jobs', 'https://jobs.oa.dev/other')).toBe(400)
    expect(secretOf(await (await get(cookie)).text())).toBe(null)
    expect(await (await get(cookie)).text()).not.toContain(secret)
  })

  it.each([
    [{ ...NEW, id: 'Bad_Id' }, 'Use lower-case letters, digits and hyphens, starting and ending with a letter or digit.'],
    [{ ...NEW, id: 'in-code' }, 'in-code is taken.'],
    [{ ...NEW, name: ' ' }, 'Give it a name.'],
    [{ ...NEW, redirects: ' ' }, 'Give it a callback URL.'],
    [{ ...NEW, redirects: 'https://evil.test/cb' }, 'https://evil.test/cb: must be under oa.dev'],
    [{ ...NEW, redirects: 'https://notoa.dev/cb' }, 'https://notoa.dev/cb: must be under oa.dev'],
    [{ ...NEW, redirects: 'http://jobs.oa.dev/cb' }, 'http://jobs.oa.dev/cb: must be https'],
    [{ ...NEW, redirects: 'https://jobs.oa.dev/cb#x' }, 'https://jobs.oa.dev/cb#x: no fragment'],
    [{ ...NEW, redirects: 'https://u:p@jobs.oa.dev/cb' }, 'https://u:p@jobs.oa.dev/cb: no credentials in the URL'],
    [{ ...NEW, redirects: 'https://JOBS.oa.dev' }, 'https://JOBS.oa.dev: write it as https://jobs.oa.dev/'],
    [{ ...NEW, postLogouts: 'https://evil.test/' }, 'https://evil.test/: must be under oa.dev'],
  ])('refuses %j', async (fields, message) => {
    const { post, cookieFor, registry } = setup()
    const res = await post('/admin/clients', fields, await cookieFor(ADMIN))
    expect(res.status).toBe(400)
    const alert = /role="alert">([^<]*)</.exec(await res.text())?.[1]
    expect(alert?.replace(/&#39;/g, "'")).toBe(message)
    expect(await registry.list()).toEqual([])
  })

  it('accepts loopback for local development', async () => {
    const { post, cookieFor, registry } = setup()
    expect((await post('/admin/clients', { ...NEW, redirects: 'http://localhost:4632/auth/oa/callback' }, await cookieFor(ADMIN))).status).toBe(200)
    expect((await registry.get('oa-jobs'))!.redirectUris).toEqual(['http://localhost:4632/auth/oa/callback'])
  })

  it('refuses an id that is taken, disabled or not', async () => {
    const { post, cookieFor, registry } = setup()
    const cookie = await cookieFor(ADMIN)
    await post('/admin/clients', NEW, cookie)
    const hash = (await registry.get('oa-jobs'))!.secretHash
    await registry.setDisabled('oa-jobs', true, ADMIN)
    expect((await post('/admin/clients', NEW, cookie)).status).toBe(400)
    expect((await registry.get('oa-jobs'))!.secretHash).toBe(hash)
  })

  it('escapes what it shows', async () => {
    const { post, get, cookieFor } = setup()
    const cookie = await cookieFor(ADMIN)
    await post('/admin/clients', { ...NEW, name: '<script>x</script>' }, cookie)
    const html = await (await get(cookie)).text()
    expect(/<span class="app-name">(.*?)<\/span>/.exec(html)?.[1]).toBe('&#60;script&#62;x&#60;/script&#62;')
    expect(html).not.toContain('<script>x')
  })
})

describe('changing an app', () => {
  it('disabling cuts the app off at once, and enabling restores it', async () => {
    const { post, cookieFor, authorize } = setup()
    const cookie = await cookieFor(ADMIN)
    await post('/admin/clients', NEW, cookie)
    expect((await post('/admin/clients/oa-jobs', { action: 'disable' }, cookie)).status).toBe(302)
    expect(await authorize('oa-jobs', CB)).toBe(400)
    await post('/admin/clients/oa-jobs', { action: 'enable' }, cookie)
    expect(await authorize('oa-jobs', CB)).toBe(302)
  })

  it('rotating needs the box ticked, then replaces the hash and shows the new secret', async () => {
    const { post, cookieFor, registry } = setup()
    const cookie = await cookieFor(ADMIN)
    await post('/admin/clients', NEW, cookie)
    const before = (await registry.get('oa-jobs'))!.secretHash

    expect((await post('/admin/clients/oa-jobs', { action: 'rotate' }, cookie)).status).toBe(400)
    expect((await registry.get('oa-jobs'))!.secretHash).toBe(before)

    const secret = secretOf(await (await post('/admin/clients/oa-jobs', { action: 'rotate', confirm: 'on' }, cookie)).text())!
    expect((await registry.get('oa-jobs'))!.secretHash).toBe(await hashClientSecret(secret))
    expect(await hashClientSecret(secret)).not.toBe(before)
  })

  it('editing validates callbacks the same way and takes effect at once', async () => {
    const { post, cookieFor, authorize, registry } = setup()
    const cookie = await cookieFor(ADMIN)
    await post('/admin/clients', NEW, cookie)
    const save = { action: 'save', name: 'Jobs 2', postLogouts: '' }
    expect((await post('/admin/clients/oa-jobs', { ...save, redirects: 'https://evil.test/' }, cookie)).status).toBe(400)
    expect((await registry.get('oa-jobs'))!.redirectUris).toEqual([CB])

    const next = 'https://jobs2.oa.dev/cb'
    expect((await post('/admin/clients/oa-jobs', { ...save, redirects: next }, cookie)).status).toBe(302)
    expect(await authorize('oa-jobs', next)).toBe(302)
    expect(await authorize('oa-jobs', CB)).toBe(400)
  })

  it('404s an unknown app, and an app in code is not editable', async () => {
    const { post, cookieFor } = setup()
    const cookie = await cookieFor(ADMIN)
    expect((await post('/admin/clients/nope', { action: 'disable' }, cookie)).status).toBe(404)
    expect((await post('/admin/clients/in-code', { action: 'disable' }, cookie)).status).toBe(404)
  })

  it('logs every change, newest first, with no secret', async () => {
    const { post, cookieFor, registry } = setup()
    const cookie = await cookieFor(ADMIN)
    await post('/admin/clients', NEW, cookie)
    await post('/admin/clients/oa-jobs', { action: 'rotate', confirm: 'on' }, cookie)
    await post('/admin/clients/oa-jobs', { action: 'disable' }, cookie)
    const events = await registry.events()
    expect(events.map(({ clientId, action, actor, detail }) => ({ clientId, action, actor, detail }))).toEqual([
      { clientId: 'oa-jobs', action: 'disable', actor: ADMIN, detail: null },
      { clientId: 'oa-jobs', action: 'rotate', actor: ADMIN, detail: null },
      { clientId: 'oa-jobs', action: 'create', actor: ADMIN, detail: JSON.stringify([CB]) },
    ])
  })

  it('a refused duplicate logs nothing', async () => {
    const { registry } = setup()
    const c = { id: 'a', name: 'A', secretHash: 'h', redirectUris: [CB] }
    expect(await registry.create(c, 'first')).toBe(true)
    expect(await registry.create({ ...c, secretHash: 'other' }, 'second')).toBe(false)
    expect((await registry.get('a'))!.secretHash).toBe('h')
    expect((await registry.events()).map(e => e.actor)).toEqual(['first'])
  })
})

describe('oa-client.mjs', () => {
  const T = 1_800_000_000

  it("writes rows the dash's registry reads", async () => {
    const { raw, registry, authorize } = setup()
    raw.exec(createSql({ id: 'oa-jobs', name: "Bob's jobs", secretHash: 'h1', redirectUris: [CB] }, 'cli:me', T))
    expect(await registry.get('oa-jobs')).toEqual({
      id: 'oa-jobs',
      name: "Bob's jobs",
      secretHash: 'h1',
      redirectUris: [CB],
      postLogoutRedirectUris: [],
      disabledAt: null,
      createdAt: T,
      createdBy: 'cli:me',
      updatedAt: T,
      updatedBy: 'cli:me',
    })
    expect(await authorize('oa-jobs', CB)).toBe(302)

    raw.exec(rotateSql('oa-jobs', 'h2', 'cli:me', T + 1))
    expect((await registry.get('oa-jobs'))!.secretHash).toBe('h2')

    raw.exec(setCallbacksSql('oa-jobs', ['https://b.oa.dev/cb'], 'cli:me', T + 2))
    expect((await registry.get('oa-jobs'))!.redirectUris).toEqual(['https://b.oa.dev/cb'])

    raw.exec(setDisabledSql('oa-jobs', true, 'cli:me', T + 3))
    expect((await registry.get('oa-jobs'))!.disabledAt).toBe(T + 3)
    expect(await authorize('oa-jobs', 'https://b.oa.dev/cb')).toBe(400)

    raw.exec(setDisabledSql('oa-jobs', false, 'cli:me', T + 4))
    expect((await registry.get('oa-jobs'))!.disabledAt).toBe(null)

    expect((await registry.events()).map(e => e.action)).toEqual(['enable', 'disable', 'update', 'rotate', 'create'])
    expect(raw.prepare(existsSql('oa-jobs')).all()).toEqual([{ id: 'oa-jobs' }])
    expect(raw.prepare(listSql).all().map((r: Record<string, unknown>) => r.id)).toEqual(['oa-jobs'])
  })

  it('quotes a literal so it stays one', () => {
    expect(lit("x'; DROP TABLE provider_clients; --")).toBe("'x''; DROP TABLE provider_clients; --'")
  })
})
