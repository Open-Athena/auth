/** Bot filtering, the first-party beacon, and retention rollup (share-links §4). */
import { beforeEach, describe, expect, it } from 'vitest'
import { d1AuditQuery, d1AuditSink, d1GrantStore, rollupAccessLog } from '../src/adapters/d1.js'
import { isBot, looksAutomated } from '../src/core/bots.js'
import { createGate } from '../src/core/gate.js'
import { anyEmailPolicy } from '../src/core/policy.js'
import { authRoutes } from '../src/core/routes.js'
import { testDb } from './d1-shim.js'

const SECRET = 'test-secret-0123456789abcdef'
const NOW = Date.parse('2026-08-16T00:00:00Z')
const NOW_S = NOW / 1000
const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0 Safari/537.36'

describe('isBot', () => {
  it('lets real browsers through', () => {
    const humans = [
      CHROME,
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0',
    ]
    expect(humans.map(isBot)).toEqual([false, false, false])
  })

  it('catches self-identifying automation, including link unfurlers', () => {
    const bots = [
      'Googlebot/2.1 (+http://www.google.com/bot.html)',
      'curl/8.4.0',
      'python-requests/2.31.0',
      'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
      'facebookexternalhit/1.1',
      'Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/140.0.0.0',
      'GPTBot/1.0',
    ]
    expect(bots.map(isBot)).toEqual([true, true, true, true, true, true, true])
  })

  it('treats a missing user-agent as automation', () => {
    expect([isBot(null), isBot(undefined), isBot(''), isBot('   ')]).toEqual([true, true, true, true])
  })

  it("trusts Cloudflare's verdict over the UA string", () => {
    const req = new Request('https://x.test/', {
      headers: { 'User-Agent': CHROME, 'CF-Verified-Bot': 'true' },
    })
    expect(looksAutomated(req)).toBe(true)
  })
})

describe('view logging vs bots', () => {
  let db: D1Database
  const gate = (extra = {}) =>
    createGate({
      store: d1GrantStore(db),
      audit: d1AuditSink(db),
      secret: SECRET,
      policy: anyEmailPolicy(['reports']),
      logViews: true,
      ...extra,
    })
  const viewCount = async () =>
    (await db.prepare(`SELECT COUNT(*) AS n FROM access_log WHERE event = 'view'`).first<{ n: number }>())!.n

  beforeEach(() => {
    db = testDb()
  })

  const authAs = async (g: ReturnType<typeof createGate>, ua: string | null) => {
    const signedIn = await g.signIn('someone@example.com', new Request('https://x.test/'), NOW)
    const cookie = signedIn!.cookie.split(';')[0]!
    const headers: Record<string, string> = { Cookie: cookie }
    if (ua) headers['User-Agent'] = ua
    return g.authenticate(new Request('https://x.test/dash', { headers }), NOW)
  }

  it('logs a human view and drops a crawler one', async () => {
    const g = gate()
    await authAs(g, CHROME)
    expect(await viewCount()).toBe(1)
    await authAs(g, 'Googlebot/2.1')
    expect(await viewCount()).toBe(1)
  })

  it('still records lifecycle events from bots — that is what you want to see', async () => {
    const g = gate()
    const { token } = await g.mint({ scopes: ['reports'], createdBy: 'admin@example.com' }, NOW)
    await g.redeem(token, new Request('https://x.test/r', { headers: { 'User-Agent': 'curl/8.4.0' } }), NOW)
    const redeems = await db.prepare(`SELECT COUNT(*) AS n FROM access_log WHERE event='redeem'`).first<{ n: number }>()
    expect(redeems!.n).toBe(1)
  })

  it('can be turned off', async () => {
    const g = gate({ filterBots: false })
    await authAs(g, 'Googlebot/2.1')
    expect(await viewCount()).toBe(1)
  })
})

describe('/track beacon', () => {
  let db: D1Database
  let handle: ReturnType<typeof authRoutes>
  let cookie: string

  beforeEach(async () => {
    db = testDb()
    const gate = createGate({
      store: d1GrantStore(db),
      audit: d1AuditSink(db),
      secret: SECRET,
      policy: anyEmailPolicy(['reports']),
    })
    handle = authRoutes(gate, { audit: d1AuditQuery(db) })
    const signedIn = await gate.signIn('someone@example.com', new Request('https://x.test/'), NOW)
    cookie = signedIn!.cookie.split(';')[0]!
  })

  const track = (path: unknown, opts: { cookie?: boolean; ua?: string } = {}) => {
    const headers: Record<string, string> = { 'content-type': 'application/json', 'User-Agent': opts.ua ?? CHROME }
    if (opts.cookie !== false) headers['Cookie'] = cookie
    return handle(
      new Request('https://x.test/api/auth/track', { method: 'POST', headers, body: JSON.stringify({ path }) }),
    )
  }
  const paths = async () =>
    (await db.prepare(`SELECT path FROM access_log WHERE event='view' ORDER BY id`).all<{ path: string }>()).results.map(
      r => r.path,
    )

  it('records the SPA route the visitor actually saw, not the beacon endpoint', async () => {
    // Without this the log would only ever show /api/track, which answers nothing.
    expect((await track('/finances/2025'))!.status).toBe(200)
    expect(await paths()).toEqual(['/finances/2025'])
  })

  it('logs exactly one row per beacon, even with view logging on', async () => {
    // The auth routes authenticate on every call; if that emitted its own view,
    // each beacon would produce a spurious `/api/auth/track` row alongside the
    // real one, and `/whoami` polling would bury the log entirely.
    const gate = createGate({
      store: d1GrantStore(db),
      audit: d1AuditSink(db),
      secret: SECRET,
      policy: anyEmailPolicy(['reports']),
      logViews: true,
    })
    handle = authRoutes(gate, { audit: d1AuditQuery(db) })
    const signedIn = await gate.signIn('someone@example.com', new Request('https://x.test/'), NOW)
    cookie = signedIn!.cookie.split(';')[0]!

    await track('/finances/2025')
    await handle(new Request('https://x.test/api/auth/whoami', { headers: { Cookie: cookie, 'User-Agent': CHROME } }))
    expect(await paths()).toEqual(['/finances/2025'])
  })

  it('rejects paths that are not same-origin, since they land in an admin table', async () => {
    const bad = ['https://evil.test/x', '//evil.test/x', 'javascript:alert(1)', '', '/'.repeat(513)]
    const statuses = await Promise.all(bad.map(async p => (await track(p))!.status))
    expect(statuses).toEqual([400, 400, 400, 400, 400])
    expect(await paths()).toEqual([])
  })

  it('drops anonymous beacons quietly', async () => {
    const res = await track('/finances', { cookie: false })
    expect(res!.status).toBe(200)
    expect(await paths()).toEqual([])
  })

  it('drops bot beacons', async () => {
    await track('/finances', { ua: 'Googlebot/2.1' })
    expect(await paths()).toEqual([])
  })
})

describe('rollupAccessLog', () => {
  let db: D1Database

  const seed = async (rows: { ts: number; event: string; path?: string; ip?: string; country?: string }[]) => {
    for (const r of rows) {
      await db
        .prepare(
          `INSERT INTO access_log (ts, event, grant_id, session_sub, path, status, ip_hash, ua, country, reason, bucket)
           VALUES (?, ?, 'g1', 'g:g1', ?, NULL, ?, NULL, ?, NULL, NULL)`,
        )
        .bind(r.ts, r.event, r.path ?? '/a', r.ip ?? 'ip1', r.country ?? 'US')
        .run()
    }
  }
  const daily = async () =>
    (
      await db
        .prepare(`SELECT day, event, path, country, events, clients FROM access_log_daily ORDER BY day, event, path`)
        .all<{ day: number; event: string; path: string; country: string; events: number; clients: number }>()
    ).results
  const rawCount = async () =>
    (await db.prepare(`SELECT COUNT(*) AS n FROM access_log`).first<{ n: number }>())!.n

  beforeEach(() => {
    db = testDb()
  })

  it('leaves recent rows alone', async () => {
    await seed([{ ts: NOW_S - 86400, event: 'view' }])
    expect(await rollupAccessLog(db, { olderThanDays: 90, nowS: NOW_S })).toEqual({
      rolledUp: 0,
      buckets: 0,
      cutoff: NOW_S - 90 * 86400,
    })
    expect(await rawCount()).toBe(1)
  })

  it('collapses old rows into daily buckets and deletes them', async () => {
    const old = NOW_S - 200 * 86400
    await seed([
      { ts: old, event: 'view', path: '/a', ip: 'ip1' },
      { ts: old + 60, event: 'view', path: '/a', ip: 'ip2' },
      { ts: old + 120, event: 'view', path: '/b', ip: 'ip1' },
      { ts: old + 180, event: 'redeem', path: '/r', ip: 'ip1' },
      { ts: NOW_S - 3600, event: 'view', path: '/recent' },
    ])
    const res = await rollupAccessLog(db, { olderThanDays: 90, nowS: NOW_S })
    expect(res.rolledUp).toBe(4)
    expect(await daily()).toEqual([
      { day: Math.floor(old / 86400), event: 'redeem', path: '/r', country: 'US', events: 1, clients: 1 },
      { day: Math.floor(old / 86400), event: 'view', path: '/a', country: 'US', events: 2, clients: 2 },
      { day: Math.floor(old / 86400), event: 'view', path: '/b', country: 'US', events: 1, clients: 1 },
    ])
    // The recent row survives untouched.
    expect(await rawCount()).toBe(1)
  })

  it('is idempotent: a second run is a no-op', async () => {
    await seed([{ ts: NOW_S - 200 * 86400, event: 'view' }])
    const first = await rollupAccessLog(db, { olderThanDays: 90, nowS: NOW_S })
    const before = await daily()
    const second = await rollupAccessLog(db, { olderThanDays: 90, nowS: NOW_S })
    expect([first.rolledUp, second.rolledUp]).toEqual([1, 0])
    expect(await daily()).toEqual(before)
  })

  it('accumulates into an existing bucket rather than replacing it', async () => {
    const day = NOW_S - 200 * 86400
    await seed([{ ts: day, event: 'view', ip: 'ip1' }])
    await rollupAccessLog(db, { olderThanDays: 90, nowS: NOW_S })
    // A late-arriving row for the same day, rolled up on a later run.
    await seed([{ ts: day + 10, event: 'view', ip: 'ip2' }])
    await rollupAccessLog(db, { olderThanDays: 90, nowS: NOW_S })
    expect((await daily()).map(r => [r.events, r.clients])).toEqual([[2, 1]])
  })

  it('merges NULL grant/path/country rows into one bucket instead of one each', async () => {
    // SQLite treats NULLs as distinct in a PRIMARY KEY, so without COALESCE
    // every NULL-path row would get its own row and never merge.
    const old = NOW_S - 200 * 86400
    for (const ts of [old, old + 60]) {
      await db
        .prepare(
          `INSERT INTO access_log (ts, event, grant_id, session_sub, path, ip_hash, country, bucket)
           VALUES (?, 'deny', NULL, NULL, NULL, 'ip1', NULL, NULL)`,
        )
        .bind(ts)
        .run()
    }
    await rollupAccessLog(db, { olderThanDays: 90, nowS: NOW_S })
    expect((await daily()).map(r => [r.event, r.path, r.country, r.events])).toEqual([['deny', '', '', 2]])
  })
})

describe('deny dedupe', () => {
  let db: D1Database
  let audit: ReturnType<typeof d1AuditSink>
  const denies = async () =>
    (
      await db
        .prepare(`SELECT event, session_sub, path, reason, bucket FROM access_log ORDER BY id`)
        .all<{ event: string; session_sub: string | null; path: string | null; reason: string; bucket: number | null }>()
    ).results

  beforeEach(() => {
    db = testDb()
    audit = d1AuditSink(db)
  })

  it('collapses repeat denials from one dead session', async () => {
    // A revoked link's browser re-denies on every page load; rows 2..n say
    // nothing row 1 didn't.
    for (const ts of [NOW_S, NOW_S + 5, NOW_S + 30]) {
      await audit.log({ ts, event: 'deny', sessionSub: 'g:abc', path: '/dash', grantId: 'abc', reason: 'revoked' })
    }
    expect((await denies()).length).toBe(1)
  })

  it('keeps every token-presented denial — repeats there are someone probing', async () => {
    for (const ts of [NOW_S, NOW_S + 5, NOW_S + 30]) {
      await audit.log({ ts, event: 'deny', path: '/api', reason: 'bad-token' })
    }
    expect((await denies()).map(r => [r.reason, r.bucket])).toEqual([
      ['bad-token', null],
      ['bad-token', null],
      ['bad-token', null],
    ])
  })

  it('starts a fresh row each hour, and per path', async () => {
    const deny = (ts: number, path: string) =>
      audit.log({ ts, event: 'deny', sessionSub: 'g:abc', path, reason: 'revoked' })
    await deny(NOW_S, '/dash')
    await deny(NOW_S + 3601, '/dash')
    await deny(NOW_S, '/other')
    expect((await denies()).map(r => r.path)).toEqual(['/dash', '/dash', '/other'])
  })

  it('does not let a deny and a view collide in the same session/path/hour', async () => {
    // The dedupe index keys on `event` too; without that, whichever landed
    // second would be silently dropped.
    await audit.log({ ts: NOW_S, event: 'view', sessionSub: 'g:abc', path: '/dash' })
    await audit.log({ ts: NOW_S, event: 'deny', sessionSub: 'g:abc', path: '/dash', reason: 'revoked' })
    expect((await denies()).map(r => r.event)).toEqual(['view', 'deny'])
  })
})
