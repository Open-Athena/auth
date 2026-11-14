// What a link's holder can learn: never the memo, and for an `anon` link never
// the name, email or photo staff gave it. An absence check is the right tool
// here: the property is "this string appears nowhere the holder can reach".
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { activityFeed, activityRoutes } from '../src/activity/index.js'
import { d1ActivityStore } from '../src/adapters/d1-activity.js'
import { d1AuditQuery, d1AuditSink, d1GrantStore } from '../src/adapters/d1.js'
import { d1SessionLogStore } from '../src/adapters/d1-session-log.js'
import { bytesToDataUri } from '../src/core/avatar.js'
import { FOREVER_MS } from '../src/core/session-log-shape.js'
import { createGate } from '../src/core/gate.js'
import { authRoutes } from '../src/core/routes.js'
import { fromGate, sessionLogRoutes } from '../src/session-log/index.js'
import { memoryAssetStore, memoryProfileStore } from '../src/testing/index.js'
import { testDbRaw } from './d1-shim.js'

const HOST = 'https://app.test'
const NOW = Date.parse('2026-11-14T12:00:00Z')
const MEMO = 'SENTINEL-MEMO-7f3a'
const NAME = 'SENTINEL-NAME-91c2'
const EMAIL = 'sentinel-email-44d1@example.test'
const PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='),
  c => c.charCodeAt(0),
)

const opened: { close(): void }[] = []
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})
afterEach(() => {
  for (const raw of opened.splice(0)) raw.close()
  vi.useRealTimers()
})

async function setup() {
  const { db, raw } = testDbRaw(['session-log', 'activity'])
  opened.push(raw)
  const assets = memoryAssetStore()
  const profiles = memoryProfileStore()
  const gate = createGate({
    store: d1GrantStore(db),
    audit: d1AuditSink(db),
    assets,
    profiles,
    allowGrantSelfEdit: true,
    secret: 'holder-privacy-secret-0123456789',
    adminEmails: ['ops@example.test'],
  })
  // The holder's own profile row exists: an `anon` link still mustn't read it back.
  await profiles.put({ email: EMAIL, name: NAME, avatar: null, avatarSrc: null, updatedAt: NOW / 1000 })
  const auth = authRoutes(gate, { audit: d1AuditQuery(db) })
  const slogStore = d1SessionLogStore(db)
  await slogStore.writeSwitch(FOREVER_MS, 'ops@example.test', NOW / 1000)
  const slog = sessionLogRoutes({ store: slogStore, ...fromGate(gate) })
  const activityStore = d1ActivityStore(db)
  const activity = activityRoutes({
    feed: activityFeed({ store: activityStore }),
    store: activityStore,
    requireAdmin: async req => {
      const a = await gate.authenticate(req)
      return a?.kind === 'sso' && a.admin ? { who: a.email } : Response.json({ error: 'admin required' }, { status: 403 })
    },
  })
  const { grant, token } = await gate.mint({
    name: MEMO,
    subject: { name: NAME, avatar: bytesToDataUri('image/png', PNG) },
    email: EMAIL,
    anon: true,
    scopes: ['view'],
    createdBy: 'ops@example.test',
  })
  const assetId = [...assets.rows.keys()][0]!
  return { auth, slog, activity, grant, token, assetId }
}

describe('an anonymous link holder', () => {
  it('finds no memo, name, email or photo in any response body or header it can reach', async () => {
    const { auth, slog, activity, grant, token, assetId } = await setup()
    // The stored photo is an `asset://<id>`, and is served as `/avatar/<id>`: the id is its sentinel.
    expect(grant.subject).toEqual({ name: NAME, avatar: `asset://${assetId}` })
    const seen: { route: string; status: number; text: string }[] = []
    const hit = async (handler: (r: Request) => Promise<Response | null>, method: string, path: string, opts: { body?: unknown; cookie?: string; bearer?: boolean } = {}) => {
      const headers: Record<string, string> = { origin: HOST }
      if (opts.cookie) headers.cookie = opts.cookie
      if (opts.bearer) headers.authorization = `Bearer ${token}`
      if (opts.body !== undefined) headers['content-type'] = 'application/json'
      const res = (await handler(new Request(`${HOST}${path}`, { method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) })))!
      const text = `${[...res.headers].map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n${await res.text()}`
      seen.push({ route: `${method} ${path}`, status: res.status, text })
      return res
    }
    const exchanged = await hit(auth, 'POST', '/api/auth/exchange', { body: { token } })
    const cookie = exchanged.headers.get('set-cookie')!.split(';')[0]!
    await hit(auth, 'GET', '/api/auth/whoami', { cookie })
    await hit(auth, 'GET', '/api/auth/whoami', { bearer: true })
    await hit(auth, 'GET', '/api/auth/profile', { cookie })
    await hit(auth, 'PUT', '/api/auth/profile', { cookie, body: { name: 'Someone' } })
    await hit(auth, 'POST', '/api/auth/track', { cookie, body: { path: '/report' } })
    await hit(auth, 'GET', '/api/auth/grants', { cookie })
    await hit(auth, 'GET', `/api/auth/grants/${grant.id}/activity`, { cookie })
    await hit(auth, 'GET', '/api/auth/log', { cookie })
    await hit(slog, 'POST', '/api/session-log', {
      bearer: true,
      body: { sid: 'sid-holder', pid: 'pid-holder', seq: 0, build: 'test', events: [{ t: NOW, k: 'start', u: '/report' }] },
    })
    await hit(slog, 'GET', '/api/session-log/sessions', { cookie })
    await hit(slog, 'GET', '/api/session-log/sessions/sid-holder', { cookie })
    await hit(activity, 'GET', '/api/activity', { cookie })
    await hit(auth, 'POST', '/api/auth/logout', { cookie })
    expect(seen.map(s => [s.route, s.status])).toEqual([
      ['POST /api/auth/exchange', 200],
      ['GET /api/auth/whoami', 200],
      ['GET /api/auth/whoami', 200],
      ['GET /api/auth/profile', 200],
      ['PUT /api/auth/profile', 403],
      ['POST /api/auth/track', 200],
      ['GET /api/auth/grants', 403],
      ['GET /api/auth/grants/' + grant.id + '/activity', 403],
      ['GET /api/auth/log', 403],
      ['POST /api/session-log', 204],
      ['GET /api/session-log/sessions', 403],
      ['GET /api/session-log/sessions/sid-holder', 403],
      ['GET /api/activity', 403],
      ['POST /api/auth/logout', 200],
    ])
    const sentinels = [MEMO, NAME, EMAIL, assetId]
    expect(seen.flatMap(s => sentinels.filter(x => s.text.toLowerCase().includes(x.toLowerCase())).map(x => [s.route, x]))).toEqual([])
  })
})
