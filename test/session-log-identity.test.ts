import { readFileSync, readdirSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { d1GrantStore } from '../src/adapters/d1.js'
import { d1SessionLogStore } from '../src/adapters/d1-session-log.js'
import { createGate } from '../src/core/gate.js'
import { FOREVER_MS, parseCursor, type SessionPage, type SessionRow, type SlogBatch } from '../src/core/session-log-shape.js'
import { fromGate, sessionLogRoutes, SessionLogNotSetUp, type SessionLogWho } from '../src/session-log/index.js'
import { testDbRaw } from './d1-shim.js'

const HOST = 'https://site.example.test'
const NOW = Date.UTC(2026, 10, 7)
const TRACKS = readdirSync(fileURLToPath(new URL('../migrations/', import.meta.url).href), { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => entry.name)
  .sort()
const opened: DatabaseSync[] = []
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})
afterEach(() => {
  for (const raw of opened.splice(0)) raw.close()
  vi.useRealTimers()
})

function database(tracks: string[] = TRACKS) {
  const result = testDbRaw(tracks)
  opened.push(result.raw)
  return result
}

function setup() {
  const { db, raw } = database()
  const gate = createGate({ store: d1GrantStore(db), secret: 'identity-test-secret', adminEmails: ['ops@example.test'] })
  return { db, raw, gate, store: d1SessionLogStore(db) }
}

const batch = (over: Partial<SlogBatch> = {}): SlogBatch => ({
  sid: 'sid-identity', pid: 'pid-identity', seq: 0, build: 'test',
  events: [{ t: NOW, k: 'start', u: '/report' }], ...over,
})
const summary = (over: Partial<SessionRow> = {}): SessionRow => ({
  sid: 'sid-identity', email: null, via: 'grant', build: 'test', ua: null,
  started_ms: NOW, last_ms: NOW, n_events: 1, n_errors: 0, n_batches: 1,
  first_url: '/report', received_ts: NOW / 1000, ...over,
})
const request = (token: string) => new Request(HOST, { headers: { authorization: `Bearer ${token}` } })
const pageShape = (page: SessionPage) => ({
  sids: page.sessions.map(s => s.sid), total: page.total, offset: page.offset, prev: page.prev, next: page.next,
})
const migration = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../migrations/session-log/${name}`, import.meta.url).href), 'utf8')

describe('trusted share-link identity', () => {
  it('uses grant ID and recipient name, never the memo or an unverified subject email; SSO/public shapes stay unchanged', async () => {
    const { gate } = setup()
    const named = await gate.mint({ name: 'Private staff memo', subject: { name: '  Ada Recipient  ', email: 'unverified@example.test' }, scopes: ['view'], createdBy: 'test' })
    const bound = await gate.mint({ name: 'Private staff memo', email: 'bound@example.test', subject: { name: 'Bound Recipient' }, scopes: ['view'], createdBy: 'test' })
    const unnamed = await gate.mint({ name: 'Private staff memo', scopes: ['view'], createdBy: 'test' })
    const blank = await gate.mint({ name: 'Private staff memo', subject: { name: '   ' }, scopes: ['view'], createdBy: 'test' })
    const sso = await gate.signIn('ops@example.test', new Request(HOST))
    if (!sso) throw new Error('test SSO sign-in refused')
    const hooks = fromGate(gate)
    expect([
      await hooks.identify(request(named.token)),
      await hooks.identify(request(bound.token)),
      await hooks.identify(request(unnamed.token)),
      await hooks.identify(request(blank.token)),
      await hooks.identify(new Request(HOST, { headers: { cookie: sso.cookie.split(';')[0]! } })),
      await hooks.identify(new Request(HOST)),
      await fromGate(gate, { anonymous: true }).identify(new Request(HOST)),
    ]).toEqual([
      { email: null, via: 'grant', grantId: named.grant.id, subjectName: 'Ada Recipient' },
      { email: 'bound@example.test', via: 'grant', grantId: bound.grant.id, subjectName: 'Bound Recipient' },
      { email: null, via: 'grant', grantId: unnamed.grant.id },
      { email: null, via: 'grant', grantId: blank.grant.id },
      { email: 'ops@example.test', via: 'sso' },
      null,
      { email: null, via: 'public' },
    ])
  })

  it('ignores forged client identity, persists the server recipient, and exposes it in admin list/detail and hooks', async () => {
    const { gate, store } = setup()
    const { grant, token } = await gate.mint({ name: 'Private staff memo', subject: { name: 'Ada Recipient' }, scopes: ['view'], createdBy: 'test' })
    await store.writeSwitch(FOREVER_MS, 'ops@example.test', NOW / 1000)
    const stored: SessionLogWho[] = []
    const handle = sessionLogRoutes({ store, ...fromGate(gate), onStored: e => { stored.push(e.who) } })
    const body = JSON.stringify({ ...batch(), grantId: 'forged', subjectName: 'Forged Name', email: 'forged@example.test', via: 'sso', grant_id: 'forged', subject_name: 'Forged Name' })
    const posted = await handle(new Request(`${HOST}/api/session-log`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body }))
    expect([posted?.status, await posted?.text()]).toEqual([204, ''])
    const expected = summary({ grant_id: grant.id, subject_name: 'Ada Recipient' })
    const sso = await gate.signIn('ops@example.test', new Request(HOST))
    if (!sso) throw new Error('test SSO sign-in refused')
    const admin = { cookie: sso.cookie.split(';')[0]! }
    const list = await handle(new Request(`${HOST}/api/session-log/sessions?email=ADA`, { headers: admin }))
    const detail = await handle(new Request(`${HOST}/api/session-log/sessions/sid-identity`, { headers: admin }))
    expect([list?.status, await list?.json(), detail?.status, await detail?.json(), stored]).toEqual([
      200, { sessions: [expected], total: 1, offset: 0, prev: null, next: null },
      200, { session: expected, events: [{ t: NOW, k: 'start', u: '/report', pid: 'pid-identity', seq: 0, _received_ms: NOW }] },
      [{ email: null, via: 'grant', grantId: grant.id, subjectName: 'Ada Recipient' }],
    ])
  })
})

describe('D1 session actor storage', () => {
  it('updates actor columns only on new batches, and clears optional identity when the viewer becomes SSO', async () => {
    const { raw, store } = setup()
    const first = { email: null, via: 'grant', grantId: 'grant-first', subjectName: 'First Recipient' }
    const next = { email: null, via: 'grant', grantId: 'grant-next', subjectName: 'Next Recipient' }
    expect(await store.ingest(first, null, batch(), NOW / 1000)).toBe('stored')
    expect(await store.ingest(next, null, batch(), NOW / 1000 + 1)).toBe('duplicate')
    expect(await store.sessionDetail('sid-identity')).toEqual({
      session: summary({ grant_id: 'grant-first', subject_name: 'First Recipient' }),
      events: [{ t: NOW, k: 'start', u: '/report', pid: 'pid-identity', seq: 0, _received_ms: NOW }],
    })
    expect(await store.ingest(next, null, batch({ seq: 1 }), NOW / 1000 + 1)).toBe('stored')
    expect(await store.listSessions({ email: 'NEXT RECIPIENT' })).toEqual({
      sessions: [summary({ grant_id: 'grant-next', subject_name: 'Next Recipient', n_events: 2, n_batches: 2, received_ts: NOW / 1000 + 1 })],
      total: 1, offset: 0, prev: null, next: null,
    })
    expect(await store.ingest({ email: 'ops@example.test', via: 'sso' }, null, batch({ seq: 2 }), NOW / 1000 + 2)).toBe('stored')
    expect(await store.listSessions({})).toEqual({
      sessions: [summary({ email: 'ops@example.test', via: 'sso', n_events: 3, n_batches: 3, received_ts: NOW / 1000 + 2 })],
      total: 1, offset: 0, prev: null, next: null,
    })
    expect(raw.prepare('SELECT grant_id, subject_name FROM session_log').all()).toEqual([{ grant_id: null, subject_name: null }])
    expect(pageShape(await store.listSessions({ email: 'Next Recipient' }))).toEqual({ sids: [], total: 0, offset: 0, prev: null, next: null })
  })

  it('searches address/name/grant ID case-insensitively with matching pagination counts and AND filters', async () => {
    const { store } = setup()
    for (const [sid, t, who, error] of [
      ['sid-name-a', NOW, { email: null, via: 'grant', grantId: 'key-one', subjectName: 'Shared Recipient' }, true],
      ['sid-name-b', NOW - 1000, { email: null, via: 'grant', grantId: 'key-two', subjectName: 'Shared Recipient' }, true],
      ['sid-email-a', NOW - 2000, { email: 'shared@example.test', via: 'sso' }, false],
      ['sid-key-a', NOW - 3000, { email: null, via: 'grant', grantId: 'key-SHARED' }, true],
    ] as const) {
      await store.ingest(who, null, batch({ sid, events: [{ t, k: error ? 'error' : 'start' }] }), NOW / 1000)
    }
    const first = await store.listSessions({ email: 'ShArEd', limit: 2 })
    const second = await store.listSessions({ email: 'ShArEd', limit: 2, after: parseCursor(first.next!)! })
    expect([
      pageShape(first), pageShape(second),
      pageShape(await store.listSessions({ email: 'ShArEd', limit: 2, before: parseCursor(second.prev!)! })),
      pageShape(await store.listSessions({ email: 'ShArEd', since: NOW - 2500, errors: true })),
      pageShape(await store.listSessions({ email: 'KEY-TWO' })),
    ]).toEqual([
      { sids: ['sid-name-a', 'sid-name-b'], total: 4, offset: 0, prev: null, next: `${NOW - 1000}.sid-name-b` },
      { sids: ['sid-email-a', 'sid-key-a'], total: 4, offset: 2, prev: `${NOW - 2000}.sid-email-a`, next: null },
      { sids: ['sid-name-a', 'sid-name-b'], total: 4, offset: 0, prev: null, next: `${NOW - 1000}.sid-name-b` },
      { sids: ['sid-name-a', 'sid-name-b'], total: 2, offset: 0, prev: null, next: null },
      { sids: ['sid-name-b'], total: 1, offset: 0, prev: null, next: null },
    ])
  })

  it('does not attribute an unbound link to the prior authenticated address on the same browser tab', async () => {
    const { store } = setup()
    await store.ingest({ email: 'prior@example.test', via: 'sso' }, null, batch(), NOW / 1000)
    await store.ingest({ email: null, via: 'grant', grantId: 'unbound-link' }, null, batch({ seq: 1 }), NOW / 1000 + 1)
    expect(await store.listSessions({})).toEqual({
      sessions: [summary({ grant_id: 'unbound-link', n_events: 2, n_batches: 2, received_ts: NOW / 1000 + 1 })],
      total: 1, offset: 0, prev: null, next: null,
    })
    expect(pageShape(await store.listSessions({ email: 'prior@example.test' }))).toEqual({ sids: [], total: 0, offset: 0, prev: null, next: null })
  })

  it('upgrades existing rows additively and omits absent fields from legacy, SSO and public JSON', async () => {
    const { db, raw } = database(TRACKS.filter(t => t !== 'session-log'))
    raw.exec(migration('0001_session_log.sql'))
    raw.prepare('INSERT INTO session_log (sid, email, via, build, started_ms, last_ms, n_events, n_errors, n_batches, first_url, received_ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('sid-identity', null, 'grant', 'test', NOW, NOW, 1, 0, 1, '/report', NOW / 1000)
    raw.exec(migration('0002_actor.sql'))
    const store = d1SessionLogStore(db)
    expect(await store.sessionDetail('sid-identity')).toEqual({ session: summary(), events: [] })
    for (const [sid, who] of [
      ['sid-public', { email: null, via: 'public' }],
      ['sid-ssoaaa', { email: 'ops@example.test', via: 'sso' }],
    ] as const) await store.ingest(who, null, batch({ sid }), NOW / 1000)
    expect(JSON.parse(JSON.stringify(await store.listSessions({})))).toEqual({
      sessions: [summary(), summary({ sid: 'sid-public', via: 'public' }), summary({ sid: 'sid-ssoaaa', email: 'ops@example.test', via: 'sso' })],
      total: 3, offset: 0, prev: null, next: null,
    })
    expect(raw.prepare('SELECT grant_id, subject_name FROM session_log ORDER BY sid').all()).toEqual([
      { grant_id: null, subject_name: null }, { grant_id: null, subject_name: null }, { grant_id: null, subject_name: null },
    ])
  })

  it('reports an unapplied actor migration explicitly and rolls back batch writes, without claiming the track is missing', async () => {
    const { db, raw } = database(TRACKS.filter(t => t !== 'session-log'))
    raw.exec(migration('0001_session_log.sql'))
    const store = d1SessionLogStore(db)
    const message = 'session log schema is outdated: apply migrations/session-log/0002_actor.sql'
    await expect(store.ingest({ email: null, via: 'grant', grantId: 'trusted' }, null, batch(), NOW / 1000)).rejects.toEqual(new Error(message))
    await expect(store.listSessions({})).rejects.toEqual(new Error(message))
    await expect(store.sessionDetail('sid-identity')).rejects.toEqual(new Error(message))
    expect(await store.readSwitch()).toBeNull()
    expect(raw.prepare('SELECT * FROM session_log_batches').all()).toEqual([])
    const missing = d1SessionLogStore(database([]).db)
    await expect(missing.listSessions({})).rejects.toEqual(new SessionLogNotSetUp())
  })
})
