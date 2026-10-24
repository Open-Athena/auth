// The session log's server side: the shape helpers, the admin switch (auth,
// default / cap / expiry, the per-instance cache, the change hook), batch
// validation (built-in field lists and declared app events), storage, the
// retention purge and the admin reads, over the real D1 schema
// (`migrations/session-log/`) and a real gate.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { d1GrantStore } from '../src/adapters/d1.js'
import { d1SessionLogStore } from '../src/adapters/d1-session-log.js'
import { createGate } from '../src/core/gate.js'
import {
  checkAppEvents,
  FOREVER_MS,
  fmtCursor,
  isForever,
  LIMITS,
  parseCursor,
  parseUntil,
  type SessionRow,
  type SlogBatch,
  switchState,
  validateBatch,
} from '../src/core/session-log-shape.js'
import { fromGate, sessionLogRoutes, type SessionLogRoutesOptions, type SwitchRow } from '../src/session-log/index.js'
import { testDbRaw } from './d1-shim.js'

const NOW = Date.UTC(2026, 9, 12, 15, 0, 0) // 2026-10-12T15:00Z
const HOST = 'https://site.example.test'
const SECRET = 'test-secret-0123456789abcdef'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})
afterEach(() => {
  vi.useRealTimers()
})

const ev = (t: number, k: string, f: Record<string, unknown> = {}) => ({ t, k, ...f })
const batchOf = (o: Partial<SlogBatch> = {}) => ({
  sid: 'sid-aaaaaa',
  pid: 'pid-111111',
  seq: 0,
  build: 'abc1234567',
  events: [ev(NOW - 5000, 'start', { u: '/?d=2026-10-10' }), ev(NOW - 4000, 'click', { n: 'scan', l: 'scan' })],
  ...o,
})
const batch = (o: Partial<SlogBatch> = {}) => JSON.stringify(batchOf(o))

describe('parseUntil and switchState', () => {
  it("empty = 7 days; a date runs through that UTC day; an instant ends at it; past, past the 31-day cap and bad values are refused", () => {
    expect(
      [
        undefined,
        '',
        '2026-10-17',
        '2026-10-12T16:00:00Z',
        '2026-10-12',
        '2026-11-12',
        '2026-10-11',
        '2026-10-12T15:00:00Z',
        '2026-11-13',
        '2027-10-17',
        'soon',
      ].map(s => parseUntil(s, NOW)),
    ).toEqual([
      { until: Date.UTC(2026, 9, 20) },
      { until: Date.UTC(2026, 9, 20) },
      { until: Date.UTC(2026, 9, 18) },
      { until: Date.UTC(2026, 9, 12, 16) },
      { until: Date.UTC(2026, 9, 13) },
      { until: Date.UTC(2026, 10, 13) },
      { error: 'until 2026-10-11 is in the past' },
      { error: 'until 2026-10-12T15:00:00Z is in the past' },
      { error: 'until 2026-11-13 is more than 31 days ahead (latest: 2026-11-12)' },
      { error: 'until 2027-10-17 is more than 31 days ahead (latest: 2026-11-12)' },
      { error: 'unparseable until: soon' },
    ])
  })

  it('the stored end: null = off; at or past it = expired; the 2100 sentinel and later read as no end date', () => {
    expect([switchState(null, NOW), switchState(NOW, NOW), switchState(NOW + 1, NOW)]).toEqual([
      { until: null, reason: 'off' },
      { until: NOW, reason: 'expired' },
      { until: NOW + 1, reason: null },
    ])
    expect(FOREVER_MS).toBe(4102444800000)
    expect([null, NOW, Date.UTC(2099, 11, 31), FOREVER_MS, Date.UTC(2200, 0, 1)].map(isForever)).toEqual([
      false, false, false, true, true,
    ])
  })
})

describe('validateBatch', () => {
  const ok = batchOf()
  const APP = { 'movie.queued': ['query', 'format'] }

  it('accepts a well-formed batch as is, app events included when declared', () => {
    const withApp = { ...ok, events: [...ok.events, ev(NOW, 'movie.queued', { query: 'q=1', format: 'mp4' })] }
    expect([validateBatch(ok), validateBatch(withApp, APP)]).toEqual([{ batch: ok }, { batch: withApp }])
  })

  it('refuses bad ids, kinds, undeclared or non-scalar fields, and oversize batches / events', () => {
    const big = Array.from({ length: LIMITS.batchEvents + 1 }, (_, i) => ev(NOW + i, 'vis', { s: 'visible' }))
    expect([
      validateBatch([]),
      validateBatch({ ...ok, sid: 'x' }),
      validateBatch({ ...ok, pid: 'has space' }),
      validateBatch({ ...ok, seq: -1 }),
      validateBatch({ ...ok, events: [] }),
      validateBatch({ ...ok, events: [ev(NOW, 'keystroke')] }),
      validateBatch({ ...ok, events: [{ k: 'nav' }] }),
      validateBatch({ ...ok, events: [ev(NOW, 'nav', { u: ['a'] })] }),
      validateBatch({ ...ok, events: [ev(NOW, 'api', { b: { items: { deep: 1 } } })] }),
      validateBatch({ ...ok, events: [ev(NOW, 'click', { l: 'x', email: 'someone@else.test' })] }),
      validateBatch({ ...ok, events: [ev(NOW, 'movie.queued', { query: 'q' })] }),
      validateBatch({ ...ok, events: [ev(NOW, 'movie.queued', { query: 'q', token: 't' })] }, APP),
      validateBatch({ ...ok, events: [ev(NOW, 'movie.queued', { query: { s3: 'url' } })] }, APP),
      validateBatch({ ...ok, events: big }),
      validateBatch({ ...ok, events: [ev(NOW, 'error', { st: 'x'.repeat(LIMITS.eventBytes) })] }),
    ]).toEqual([
      { status: 400, error: 'body must be a JSON object' },
      { status: 400, error: 'bad sid' },
      { status: 400, error: 'bad pid' },
      { status: 400, error: 'bad seq' },
      { status: 400, error: 'events must be a non-empty array' },
      { status: 400, error: 'event 0: unknown kind keystroke' },
      { status: 400, error: 'event 0: bad t' },
      { status: 400, error: 'event 0: bad field u' },
      { status: 400, error: 'event 0: bad field b' },
      { status: 400, error: 'event 0: undeclared field email' },
      { status: 400, error: 'event 0: unknown kind movie.queued' },
      { status: 400, error: 'event 0: undeclared field token' },
      { status: 400, error: 'event 0: bad field query' },
      { status: 413, error: 'more than 300 events' },
      { status: 413, error: 'event 0: over 4096 bytes' },
    ])
  })

  it('app event declarations: a bad name, a built-in kind, or a reserved field throws', () => {
    const msg = (app: Record<string, string[]>) => {
      try {
        checkAppEvents(app)
        return 'ok'
      } catch (e) {
        return (e as Error).message
      }
    }
    expect([
      msg({ 'movie.queued': ['query'], 'movie.download': [] }),
      msg({ Movie: [] }),
      msg({ nav: ['u'] }),
      msg({ 'movie.queued': ['t'] }),
      msg({ 'movie.queued': ['has space'] }),
    ]).toEqual([
      'ok',
      'session log: bad app event name "Movie"',
      'session log: app event nav shadows a built-in kind',
      'session log: app event movie.queued: bad field "t"',
      'session log: app event movie.queued: bad field "has space"',
    ])
  })
})

/** A fresh deployment: a gate, the routes over D1, and a viewer link and admin session. */
async function setup(o: { on?: string | null; routes?: Partial<SessionLogRoutesOptions>; anonymous?: boolean } = {}) {
  const { db, raw } = testDbRaw(['session-log'])
  const gate = createGate({ store: d1GrantStore(db), secret: SECRET, adminEmails: ['ops@example.test'] })
  const switches: { prior: SwitchRow | null; row: SwitchRow }[] = []
  const handle = sessionLogRoutes({
    store: d1SessionLogStore(db, { purgeChunk: 2 }),
    ...fromGate(gate, { anonymous: o.anonymous }),
    onSwitch: ({ prior, row }) => void switches.push({ prior, row }),
    ...o.routes,
  })
  const viewer = (await gate.mint({ email: 'ann@example.test', scopes: ['view'], createdBy: 'test' })).token
  const adminCookie = (await gate.signIn('ops@example.test', new Request(HOST), NOW))!.cookie.split(';')[0]!
  const call = async (
    method: string,
    path: string,
    opts: { token?: string; admin?: boolean; body?: string; headers?: Record<string, string> } = {},
  ) => {
    const res = await handle(
      new Request(`${HOST}/api/session-log${path}`, {
        method,
        body: opts.body,
        headers: {
          ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
          ...(opts.admin ? { cookie: adminCookie } : {}),
          'user-agent': 'UA/1',
          ...opts.headers,
        },
      }),
    )
    if (!res) throw new Error(`not handled: ${path}`)
    const text = await res.text()
    return [res.status, text ? JSON.parse(text) : null] as const
  }
  const put = (body: unknown, auth: { admin?: boolean; token?: string } = { admin: true }) =>
    call('PUT', '/switch', { ...auth, body: JSON.stringify(body) })
  if (o.on !== null) {
    const [st] = await put({ enabled: true, until: o.on ?? '2026-10-17' })
    if (st !== 200) throw new Error(`switch PUT: ${st}`)
    switches.length = 0
  }
  return { db, raw, gate, handle, call, put, viewer, switches }
}

describe('the switch: GET / PUT <base>/switch', () => {
  const bounds = { defaultUntil: Date.UTC(2026, 9, 20), maxUntil: Date.UTC(2026, 10, 13) }
  const nowS = NOW / 1000

  it('admins only: signed out 401, a viewer 403 (and a refused PUT changes nothing)', async () => {
    const s = await setup({ on: null })
    expect([
      await s.call('GET', '/switch'),
      await s.call('GET', '/switch', { token: s.viewer }),
      await s.put({ enabled: true }, { token: s.viewer }),
      await s.call('DELETE', '/switch', { admin: true }),
    ]).toEqual([
      [401, { error: 'unauthenticated', reason: null }],
      [403, { error: 'forbidden' }],
      [403, { error: 'forbidden' }],
      [405, { error: 'method not allowed' }],
    ])
    expect(s.raw.prepare('SELECT * FROM session_log_switch').all()).toEqual([])
  })

  it('off by default; on with no date = 7 days; a date; off again — each change reported to `onSwitch`', async () => {
    const s = await setup({ on: null })
    const on7 = { enabled: true, until: Date.UTC(2026, 9, 20), indefinite: false, reason: null, who: 'ops@example.test', ts: nowS, ...bounds }
    const off = { enabled: false, until: null, indefinite: false, reason: 'off', who: 'ops@example.test', ts: nowS, ...bounds }
    expect([
      await s.call('GET', '/switch', { admin: true }),
      await s.put({ enabled: true }),
      await s.put({ enabled: true, until: '2026-10-14' }),
      await s.put({ enabled: false, until: '2026-10-14' }),
      await s.call('GET', '/switch', { admin: true }),
    ]).toEqual([
      [200, { ...off, who: null, ts: null }],
      [200, on7],
      [200, { ...on7, until: Date.UTC(2026, 9, 15) }],
      [200, off],
      [200, off],
    ])
    expect(s.raw.prepare('SELECT * FROM session_log_switch').all()).toEqual([{ id: 1, until_ms: null, who: 'ops@example.test', ts: nowS }])
    const row = (until_ms: number | null) => ({ until_ms, who: 'ops@example.test', ts: nowS })
    expect(s.switches).toEqual([
      { prior: null, row: row(Date.UTC(2026, 9, 20)) },
      { prior: row(Date.UTC(2026, 9, 20)), row: row(Date.UTC(2026, 9, 15)) },
      { prior: row(Date.UTC(2026, 9, 15)), row: row(null) },
    ])
  })

  it('refuses past the 31-day cap, past dates and bad bodies (nothing stored)', async () => {
    const s = await setup({ on: null })
    expect([
      await s.put({ enabled: true, until: '2026-11-13' }),
      await s.put({ enabled: true, until: '2026-10-01' }),
      await s.put({ enabled: 'yes' }),
      await s.put({ enabled: true, until: 20261017 }),
      await s.call('PUT', '/switch', { admin: true, body: '{nope' }),
    ]).toEqual([
      [400, { error: 'until 2026-11-13 is more than 31 days ahead (latest: 2026-11-12)' }],
      [400, { error: 'until 2026-10-01 is in the past' }],
      [400, { error: 'enabled must be true or false' }],
      [400, { error: 'until must be a date string' }],
      [400, { error: 'body is not JSON' }],
    ])
    expect([s.raw.prepare('SELECT * FROM session_log_switch').all(), s.switches]).toEqual([[], []])
  })

  it('expires by itself: past its end the switch reads off (expired), with no write', async () => {
    const s = await setup({ on: '2026-10-12' })
    vi.setSystemTime(Date.UTC(2026, 9, 13))
    expect(await s.call('GET', '/switch', { admin: true })).toEqual([
      200,
      {
        enabled: false,
        until: Date.UTC(2026, 9, 13),
        indefinite: false,
        reason: 'expired',
        who: 'ops@example.test',
        ts: nowS,
        defaultUntil: Date.UTC(2026, 9, 21),
        maxUntil: Date.UTC(2026, 10, 14),
      },
    ])
  })

  it('no end date: stored as FOREVER_MS; a date with it, or with enabled: false, is refused', async () => {
    const s = await setup({ on: null })
    const forever = { enabled: true, until: FOREVER_MS, indefinite: true, reason: null, who: 'ops@example.test', ts: nowS, ...bounds }
    expect([
      await s.put({ enabled: true, indefinite: true }),
      await s.put({ enabled: true, indefinite: true, until: '2026-10-14' }),
      await s.put({ enabled: false, indefinite: true }),
      await s.put({ enabled: true, indefinite: 'yes' }),
      await s.call('GET', '', { token: s.viewer }),
    ]).toEqual([
      [200, forever],
      [400, { error: 'until and indefinite are exclusive' }],
      [400, { error: 'indefinite needs enabled: true' }],
      [400, { error: 'indefinite must be true or false' }],
      [200, { enabled: true, until: FOREVER_MS, reason: null, on: true, retainDays: 30, appEvents: {} }],
    ])
  })

  it('without the migration: reads "not set up", a PUT is 503', async () => {
    const s = await setup({ on: null })
    s.raw.exec('DROP TABLE session_log_switch')
    expect([await s.call('GET', '/switch', { admin: true }), await s.put({ enabled: true })]).toEqual([
      [200, { enabled: false, until: null, indefinite: false, reason: 'not set up', who: null, ts: null, ...bounds }],
      [503, { error: 'session log is not set up on this deployment (no session_log table)' }],
    ])
  })
})

describe('GET <base> (the boot config)', () => {
  const cfg = (enabled: boolean, until: number | null, reason: string | null, on: boolean) => ({
    enabled,
    until,
    reason,
    on,
    retainDays: 30,
    appEvents: {},
  })

  it('off unless switched on, off once expired, on only for a viewer', async () => {
    const off = await setup({ on: null })
    const on = await setup()
    expect([
      await off.call('GET', ''),
      await off.call('GET', '', { token: off.viewer }),
      await on.call('GET', ''),
      await on.call('GET', '', { token: on.viewer }),
      await on.call('GET', '', { admin: true }),
    ]).toEqual([
      [200, cfg(false, null, 'off', false)],
      [200, cfg(false, null, 'off', false)],
      [200, cfg(false, Date.UTC(2026, 9, 18), 'no viewer identity', true)],
      [200, cfg(true, Date.UTC(2026, 9, 18), null, true)],
      [200, cfg(true, Date.UTC(2026, 9, 18), null, true)],
    ])
    vi.setSystemTime(Date.UTC(2026, 9, 18))
    expect(await on.call('GET', '', { token: on.viewer })).toEqual([200, cfg(false, Date.UTC(2026, 9, 18), 'expired', false)])
  })

  it('`anonymous` logs visitors with no session; the declared app events ride along', async () => {
    const pub = await setup({ anonymous: true, routes: { appEvents: { 'movie.queued': ['query'] } } })
    expect(await pub.call('GET', '')).toEqual([
      200,
      { ...cfg(true, Date.UTC(2026, 9, 18), null, true), appEvents: { 'movie.queued': ['query'] } },
    ])
  })

  it('reads the switch at most once per 60 s per instance; an admin change through it applies at once', async () => {
    const s = await setup({ on: null })
    const enabled = async () => (await s.call('GET', '', { token: s.viewer }))[1].enabled
    const seen = [await enabled()]
    // Another isolate turns it on: this one keeps its read until the TTL passes.
    s.raw.exec(`INSERT INTO session_log_switch (id, until_ms, who, ts) VALUES (1, ${Date.UTC(2026, 9, 18)}, 'x', 0)`)
    seen.push(await enabled())
    vi.setSystemTime(NOW + 59_999)
    seen.push(await enabled())
    vi.setSystemTime(NOW + 60_000)
    seen.push(await enabled())
    await s.put({ enabled: false })
    seen.push(await enabled())
    expect(seen).toEqual([false, false, false, true, false])
  })

  it('a cached read still expires on the instant (the cache holds the end, not the answer)', async () => {
    const s = await setup({ on: new Date(NOW + 30_000).toISOString() })
    const seen = [(await s.call('GET', '', { token: s.viewer }))[1]]
    vi.setSystemTime(NOW + 30_000)
    seen.push((await s.call('GET', '', { token: s.viewer }))[1])
    expect(seen).toEqual([cfg(true, NOW + 30_000, null, true), cfg(false, NOW + 30_000, 'expired', false)])
  })

  it('without the migration: off ("not set up")', async () => {
    const s = await setup({ on: null })
    s.raw.exec('DROP TABLE session_log_switch')
    expect(await s.call('GET', '', { token: s.viewer })).toEqual([200, cfg(false, null, 'not set up', false)])
  })
})

describe('POST <base>', () => {
  it('stores a batch under the request identity (never the client’s) and summarizes the session', async () => {
    const { call, viewer, raw } = await setup()
    expect(await call('POST', '', { token: viewer, body: batch() })).toEqual([204, null])
    expect(
      await call('POST', '', {
        token: viewer,
        body: batch({
          seq: 1,
          events: [
            ev(NOW - 3000, 'api', { u: '/api/subtree', s: 500, ms: 12 }),
            ev(NOW - 2000, 'error', { msg: 'boom' }),
            ev(NOW - 1000, 'api', { u: '/api/x', s: 200, ms: 3 }),
          ],
        }),
      }),
    ).toEqual([204, null])
    expect(raw.prepare('SELECT * FROM session_log').all()).toEqual([
      {
        sid: 'sid-aaaaaa',
        email: 'ann@example.test',
        via: 'grant',
        build: 'abc1234567',
        ua: 'UA/1',
        started_ms: NOW - 5000,
        last_ms: NOW - 1000,
        n_events: 5,
        n_errors: 2,
        n_batches: 2,
        first_url: '/?d=2026-10-10',
        received_ts: NOW / 1000,
      },
    ])
    expect(raw.prepare('SELECT sid, pid, seq, received_ts, first_ms, last_ms, n FROM session_log_batches ORDER BY seq').all()).toEqual([
      { sid: 'sid-aaaaaa', pid: 'pid-111111', seq: 0, received_ts: NOW / 1000, first_ms: NOW - 5000, last_ms: NOW - 4000, n: 2 },
      { sid: 'sid-aaaaaa', pid: 'pid-111111', seq: 1, received_ts: NOW / 1000, first_ms: NOW - 3000, last_ms: NOW - 1000, n: 3 },
    ])
  })

  it('a repeated (sid, pid, seq) — a retried beacon — is ignored and counts nothing', async () => {
    const { call, viewer, raw } = await setup()
    await call('POST', '', { token: viewer, body: batch() })
    expect(await call('POST', '', { token: viewer, body: batch() })).toEqual([204, null])
    expect(raw.prepare('SELECT n_events, n_batches FROM session_log').all()).toEqual([{ n_events: 2, n_batches: 1 }])
  })

  it('refuses: signed out (401), off or expired (503), bad body (400), oversize (413), no tables (503)', async () => {
    const s = await setup()
    const past = await setup({ on: '2026-10-12' })
    past.raw.exec(`UPDATE session_log_switch SET until_ms = ${NOW - 1}`)
    await past.call('GET', '/switch', { admin: true }) // the admin read refreshes this instance's cache
    const bare = await setup()
    bare.raw.exec('DROP TABLE session_log; DROP TABLE session_log_batches')
    const huge = JSON.stringify({ pad: 'x'.repeat(LIMITS.bodyBytes) })
    const off = await setup({ on: null })
    expect([
      await off.call('POST', '', { token: off.viewer, body: batch() }),
      await s.call('POST', '', { body: batch() }),
      await past.call('POST', '', { token: past.viewer, body: batch() }),
      await s.call('POST', '', { token: s.viewer, body: '{nope' }),
      await s.call('POST', '', { token: s.viewer, body: batch({ sid: '!' }) }),
      await s.call('POST', '', { token: s.viewer, body: huge }),
      await s.call('POST', '', { token: s.viewer, body: batch(), headers: { 'content-length': String(LIMITS.bodyBytes + 1) } }),
      await bare.call('POST', '', { token: bare.viewer, body: batch() }),
      await s.call('PUT', '', { token: s.viewer, body: batch() }),
    ]).toEqual([
      [503, { error: 'session log is off' }],
      [401, { error: 'unauthenticated' }],
      [503, { error: 'session log is off' }],
      [400, { error: 'body is not JSON' }],
      [400, { error: 'bad sid' }],
      [413, { error: 'body over 65536 bytes' }],
      [413, { error: 'body over 65536 bytes' }],
      [503, { error: 'session log is not set up on this deployment (no session_log table)' }],
      [405, { error: 'method not allowed' }],
    ])
    expect(s.raw.prepare('SELECT COUNT(*) AS n FROM session_log_batches').all()).toEqual([{ n: 0 }])
  })

  it(`a session past ${LIMITS.sessionEvents} events stores nothing more (429)`, async () => {
    const { call, viewer, raw } = await setup()
    await call('POST', '', { token: viewer, body: batch() })
    raw.exec(`UPDATE session_log SET n_events = ${LIMITS.sessionEvents - 1}`)
    expect(await call('POST', '', { token: viewer, body: batch({ seq: 1 }) })).toEqual([429, { error: 'session over 20000 events' }])
    expect(raw.prepare('SELECT COUNT(*) AS n FROM session_log_batches').all()).toEqual([{ n: 1 }])
  })

  it('`filterEvents` drops events before storage (all of them = nothing stored); `onStored` runs through `waitUntil`', async () => {
    const stored: { sid: string; kinds: string[]; who: unknown }[] = []
    const s = await setup({
      routes: {
        appEvents: { 'movie.queued': ['query'] },
        filterEvents: events => events.filter(e => e.k !== 'click'),
        onStored: ({ batch: b, who }) => void stored.push({ sid: b.sid, kinds: b.events.map(e => e.k), who }),
      },
    })
    const pending: Promise<unknown>[] = []
    const post = async (body: string) => {
      const res = await s.handle(
        new Request(`${HOST}/api/session-log`, { method: 'POST', body, headers: { authorization: `Bearer ${s.viewer}` } }),
        { waitUntil: p => void pending.push(p) },
      )
      return res!.status
    }
    expect([
      await post(batch({ events: [ev(NOW, 'start', { u: '/' }), ev(NOW, 'click', { l: 'x' }), ev(NOW, 'movie.queued', { query: 'q=1' })] })),
      await post(batch({ seq: 1, events: [ev(NOW, 'click', { l: 'only' })] })),
    ]).toEqual([204, 204])
    await Promise.all(pending)
    expect(stored).toEqual([{ sid: 'sid-aaaaaa', kinds: ['start', 'movie.queued'], who: { email: 'ann@example.test', via: 'grant' } }])
    expect(s.raw.prepare('SELECT seq, events FROM session_log_batches').all()).toEqual([
      { seq: 0, events: JSON.stringify([{ t: NOW, k: 'start', u: '/' }, { t: NOW, k: 'movie.queued', query: 'q=1' }]) },
    ])
  })
})

describe('retention', () => {
  it('purges what was received before the cutoff from both tables, in bounded chunks that later calls continue', async () => {
    const { raw, db } = await setup()
    const store = d1SessionLogStore(db, { purgeChunk: 2, purgeChunks: 2 })
    const ins = raw.prepare('INSERT INTO session_log_batches VALUES (?, ?, ?, ?, 0, 0, 1, ?)')
    for (let i = 0; i < 6; i++) ins.run(`sid-old00${i}`, 'pid-111111', 0, 100, '[]')
    ins.run('sid-newnew', 'pid-111111', 0, 5000, '[]')
    raw.exec("INSERT INTO session_log (sid, started_ms, last_ms, n_events, n_errors, n_batches, received_ts) VALUES ('sid-old000', 0, 0, 1, 0, 1, 100)")
    expect([await store.purge(1000), await store.purge(1000), await store.purge(1000)]).toEqual([
      { batches: 4, sessions: 1 },
      { batches: 2, sessions: 0 },
      { batches: 0, sessions: 0 },
    ])
    expect([raw.prepare('SELECT sid FROM session_log_batches').all(), raw.prepare('SELECT sid FROM session_log').all()]).toEqual([
      [{ sid: 'sid-newnew' }],
      [],
    ])
  })

  it('the config GET purges past `retainDays` — with logging off — at most hourly, and calls `onPurge`; a missing table is a nop', async () => {
    const cutoffs: number[] = []
    const s = await setup({ on: null, routes: { retainDays: 7, onPurge: c => void cutoffs.push(c) } })
    const day = 86_400
    s.raw.exec(`
      INSERT INTO session_log (sid, started_ms, last_ms, n_events, n_errors, n_batches, received_ts) VALUES
        ('old', 0, 0, 1, 0, 1, ${NOW / 1000 - 8 * day}), ('new', 0, 0, 1, 0, 1, ${NOW / 1000 - 6 * day});
    `)
    await s.call('GET', '')
    expect(s.raw.prepare('SELECT sid FROM session_log').all()).toEqual([{ sid: 'new' }])
    vi.setSystemTime(NOW + 30 * 60_000)
    await s.call('GET', '')
    vi.setSystemTime(NOW + 2 * day * 1000)
    await s.call('GET', '')
    expect([s.raw.prepare('SELECT sid FROM session_log').all(), cutoffs]).toEqual([
      [],
      [NOW / 1000 - 7 * day, NOW / 1000 - 5 * day],
    ])
    const bare = await setup()
    bare.raw.exec('DROP TABLE session_log; DROP TABLE session_log_batches')
    expect((await bare.call('GET', '', { token: bare.viewer }))[0]).toBe(200)
  })
})

describe('session list pages (keyset on last_ms desc, sid)', () => {
  /** Sessions `s0000`…: `last_ms` = NOW − i·1000, but `s0004`–`s0006` share one `last_ms` (ties order by sid); odd ones
   *  have errors; even ones are bob's. */
  async function seeded(n: number) {
    const s = await setup({ on: null })
    const ins = s.raw.prepare('INSERT INTO session_log VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    for (let i = 0; i < n; i++) {
      const last = i >= 4 && i <= 6 ? NOW - 4000 : NOW - i * 1000
      ins.run(`sid-s${String(i).padStart(4, '0')}`, i % 2 ? 'ann@example.test' : 'bob@example.test', 'sso', 'b', null, last - 500, last, 1, i % 2, 1, null, NOW / 1000)
    }
    return { ...s, store: d1SessionLogStore(s.db) }
  }
  const page = (r: { sessions: SessionRow[]; total: number; offset: number; prev: string | null; next: string | null }) => ({
    sids: r.sessions.map(x => x.sid.slice(5)),
    total: r.total,
    offset: r.offset,
    prev: r.prev,
    next: r.next,
  })
  const cur = (i: number, last = NOW - i * 1000) => `${last}.sid-s${String(i).padStart(4, '0')}`

  it('cursors: `<last_ms>.<sid>` round-trips; anything else is refused', () => {
    expect([
      fmtCursor({ last_ms: NOW, sid: 'sid-aaaaaa' }),
      parseCursor(`${NOW}.sid-aaaaaa`),
      parseCursor('sid-aaaaaa'),
      parseCursor(`${NOW}.sid`),
      parseCursor('-1.sid-aaaaaa'),
      parseCursor(`${NOW}.sid-aa.aaaa`),
    ]).toEqual([`${NOW}.sid-aaaaaa`, { lastMs: NOW, sid: 'sid-aaaaaa' }, null, null, null, null])
  })

  it('walks forward and back by 3s, ties in sid order, counts exact; a short "newer" page is answered as the first', async () => {
    const { store } = await seeded(8)
    const p1 = await store.listSessions({ limit: 3 })
    const p2 = await store.listSessions({ limit: 3, after: parseCursor(p1.next!)! })
    const p3 = await store.listSessions({ limit: 3, after: parseCursor(p2.next!)! })
    expect([page(p1), page(p2), page(p3)]).toEqual([
      { sids: ['0000', '0001', '0002'], total: 8, offset: 0, prev: null, next: cur(2) },
      { sids: ['0003', '0004', '0005'], total: 8, offset: 3, prev: cur(3), next: cur(5, NOW - 4000) },
      { sids: ['0006', '0007'], total: 8, offset: 6, prev: cur(6, NOW - 4000), next: null },
    ])
    expect([
      page(await store.listSessions({ limit: 3, before: parseCursor(p3.prev!)! })),
      page(await store.listSessions({ limit: 3, before: parseCursor(p2.prev!)! })),
      page(await store.listSessions({ limit: 3, before: parseCursor(cur(2))! })),
      page(await store.listSessions({ limit: 3, after: parseCursor(cur(7))! })),
    ]).toEqual([
      { sids: ['0003', '0004', '0005'], total: 8, offset: 3, prev: cur(3), next: cur(5, NOW - 4000) },
      { sids: ['0000', '0001', '0002'], total: 8, offset: 0, prev: null, next: cur(2) },
      { sids: ['0000', '0001', '0002'], total: 8, offset: 0, prev: null, next: cur(2) },
      { sids: [], total: 8, offset: 8, prev: null, next: null },
    ])
  })

  it('filters apply to the page and its counts; the default page is 50', async () => {
    const { store } = await seeded(120)
    const errs = await store.listSessions({ errors: true, limit: 2 })
    const bob = await store.listSessions({ email: 'BOB', since: NOW - 5000, limit: 2 })
    expect([
      page(errs),
      page(await store.listSessions({ errors: true, limit: 2, after: parseCursor(errs.next!)! })),
      page(bob),
      page(await store.listSessions({ email: 'BOB', since: NOW - 5000, limit: 2, after: parseCursor(bob.next!)! })),
    ]).toEqual([
      { sids: ['0001', '0003'], total: 60, offset: 0, prev: null, next: cur(3) },
      { sids: ['0005', '0007'], total: 60, offset: 2, prev: cur(5, NOW - 4000), next: cur(7) },
      { sids: ['0000', '0002'], total: 4, offset: 0, prev: null, next: cur(2) },
      { sids: ['0004', '0006'], total: 4, offset: 2, prev: cur(4, NOW - 4000), next: null },
    ])
    const first = await store.listSessions({})
    expect([first.sessions.length, first.total, first.offset, first.next]).toEqual([50, 120, 0, cur(49)])
  })

  it('GET /sessions: after= / before= pages; both, or a bad cursor, is 400', async () => {
    const s = await seeded(5)
    const get = async (q: string) => {
      const [st, b] = await s.call('GET', `/sessions${q}`, { admin: true })
      return st === 200 ? page(b) : [st, b]
    }
    expect([
      await get('?limit=2'),
      await get(`?limit=2&after=${cur(1)}`),
      await get(`?limit=2&before=${cur(4, NOW - 4000)}`),
      await get(`?after=${cur(1)}&before=${cur(1)}`),
      await get('?after=nope'),
    ]).toEqual([
      { sids: ['0000', '0001'], total: 5, offset: 0, prev: null, next: cur(1) },
      { sids: ['0002', '0003'], total: 5, offset: 2, prev: cur(2), next: cur(3) },
      { sids: ['0002', '0003'], total: 5, offset: 2, prev: cur(2), next: cur(3) },
      [400, { error: 'after and before are exclusive' }],
      [400, { error: 'bad cursor: nope' }],
    ])
  })
})

describe('admin reads', () => {
  it('lists sessions (filters) and returns one session’s events in time order — admins only', async () => {
    const { call, viewer, gate } = await setup()
    const other = (await gate.mint({ email: 'cat@example.test', scopes: ['view'], createdBy: 'test' })).token
    await call('POST', '', { token: viewer, body: batch({ events: [ev(NOW - 5000, 'start', { u: '/' }), ev(NOW - 1000, 'nav', { u: '/a' })] }) })
    // A reload: the same tab's sid, a new page load; its clock interleaves.
    await call('POST', '', { token: viewer, body: batch({ pid: 'pid-222222', events: [ev(NOW - 3000, 'error', { msg: 'x' })] }) })
    await call('POST', '', { token: other, body: batch({ sid: 'sid-cccccc', events: [ev(NOW - 9000, 'start', { u: '/admin' })] }) })
    const sids = (r: readonly [number, { sessions: { sid: string }[] }]) => r[1].sessions.map(x => x.sid)
    expect([
      await call('GET', '/sessions', { token: viewer }),
      sids(await call('GET', '/sessions', { admin: true })),
      sids(await call('GET', '/sessions?email=ANN', { admin: true })),
      sids(await call('GET', '/sessions?errors=1', { admin: true })),
      sids(await call('GET', `/sessions?since=${new Date(NOW - 2000).toISOString()}`, { admin: true })),
      await call('GET', '/sessions/nope-nope', { admin: true }),
    ]).toEqual([
      [403, { error: 'forbidden' }],
      ['sid-aaaaaa', 'sid-cccccc'],
      ['sid-aaaaaa'],
      ['sid-aaaaaa'],
      ['sid-aaaaaa'],
      [404, { error: 'no session nope-nope' }],
    ])
    expect(await call('GET', '/sessions/sid-aaaaaa', { admin: true })).toEqual([
      200,
      {
        session: {
          sid: 'sid-aaaaaa',
          email: 'ann@example.test',
          via: 'grant',
          build: 'abc1234567',
          ua: 'UA/1',
          started_ms: NOW - 5000,
          last_ms: NOW - 1000,
          n_events: 3,
          n_errors: 1,
          n_batches: 2,
          first_url: '/',
          received_ts: NOW / 1000,
        },
        events: [
          { t: NOW - 5000, k: 'start', u: '/', pid: 'pid-111111', seq: 0 },
          { t: NOW - 3000, k: 'error', msg: 'x', pid: 'pid-222222', seq: 0 },
          { t: NOW - 1000, k: 'nav', u: '/a', pid: 'pid-111111', seq: 0 },
        ],
      },
    ])
  })

  it('ignores paths outside its base, so an app can fall through', async () => {
    const { handle } = await setup()
    expect([await handle(new Request(`${HOST}/api/other`)), await handle(new Request(`${HOST}/api/session-logs`))]).toEqual([null, null])
  })
})
