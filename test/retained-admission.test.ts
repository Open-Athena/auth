import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { d1RetainedStore } from '../src/adapters/d1-retained.js'
import { d1GrantStore, d1PendingAuthStore } from '../src/adapters/d1.js'
import { emailCodeAuth } from '../src/core/email-codes.js'
import { createGate } from '../src/core/gate.js'
import { authRoutes } from '../src/core/routes.js'
import { hashToken } from '../src/core/tokens.js'
import { RetainedLoginError } from '../src/core/retained.js'
import type { PendingIncoming, RetainedLimits } from '../src/core/retained-store.js'
import { testDbRaw } from './d1-shim.js'

const LIMITS = {
  sessions: 2, pending: 4, gateBrowserSets: 100, gatePending: 100,
  browserTtlS: 3000, pendingTtlS: 600, retryTtlS: 900, defaultSessionTtlS: 3600,
  admissionWindowS: 60, gateBootstrapsPerWindow: 2, gatePendingsPerWindow: 2,
}
const close: (() => void)[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const fn of close.splice(0)) fn()
})

async function pressure(promise: Promise<unknown>) {
  try {
    return await promise
  } catch (error) {
    if (!(error instanceof RetainedLoginError)) throw error
    return { code: error.code, status: error.status }
  }
}

function fixture(overrides: Partial<RetainedLimits> = {}) {
  const { raw } = testDbRaw(['retained-login'])
  close.push(() => raw.close())
  raw.exec('PRAGMA foreign_keys = ON')
  const executions = new WeakMap<D1PreparedStatement, () => D1Result>()
  let failAt: number | null = null
  const prepare = (text: string, args: (string | number | null)[] = []): D1PreparedStatement => {
    const execute = () => ({
      results: raw.prepare(text).all(...args), success: true,
      meta: { changes: Number(raw.prepare('SELECT changes() AS n').get()!.n) },
    }) as D1Result
    const statement = {
      bind: (...values: (string | number | null)[]) => prepare(text, values),
      first: async () => raw.prepare(text).get(...args) ?? null,
      all: async () => execute(), run: async () => execute(),
    } as unknown as D1PreparedStatement
    executions.set(statement, execute)
    return statement
  }
  const db = {
    prepare,
    batch: async (statements: D1PreparedStatement[]) => {
      raw.exec('BEGIN IMMEDIATE')
      try {
        const results = statements.map((statement, index) => {
          if (index === failAt) throw new Error(`Injected batch failure at ${index}`)
          return executions.get(statement)!()
        })
        raw.exec('COMMIT')
        return results
      } catch (error) {
        raw.exec('ROLLBACK')
        throw error
      }
    },
  } as unknown as D1Database
  const store = d1RetainedStore(db, { ...LIMITS, ...overrides })
  const snapshot = () => Object.fromEntries([
    'grants', 'pending_auth', 'retained_browser_sets', 'retained_pending', 'retained_sessions', 'retained_operations', 'retained_admission',
  ].map(table => [table, raw.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))
  const counters = () => raw.prepare(`SELECT gate_id, kind, window_start, used, stage
    FROM retained_admission ORDER BY gate_id, kind`).all()
  const grant = (hash = 'proof-hash') => raw.prepare(`INSERT INTO grants
    (id, token_hash, scopes, created_at, created_by, max_redeems) VALUES ('grant', ?, 'read', 1, 'admin', 1)`).run(hash)
  return { raw, db, store, snapshot, counters, grant, fail: (index: number) => { failAt = index } }
}

const browser = (id: string, gateId = 'gate') => ({ gateId, browserSetId: id, handleHash: `hash-${id}` })
const pending = (id: string, browserId: string, gateId = 'gate', version = 0): PendingIncoming => ({
  ...browser(browserId, gateId), pendingId: id, grantId: 'grant', tokenHash: 'proof-hash',
  expected: { browserSetId: browserId, sessionId: null, version },
})

describe('gate-wide retained allocation admission', () => {
  it('new browser handles and a recreated adapter cannot evade the gate allowance', async () => {
    const f = fixture()
    expect(await f.store.bootstrap(browser('one'), 100)).toBe(true)
    expect(await f.store.bootstrap(browser('two'), 100)).toBe(true)
    const restarted = d1RetainedStore(f.db, LIMITS)
    expect(await pressure(restarted.bootstrap(browser('three'), 100))).toEqual({ code: 'retained-rate-limit', status: 429 })
    expect(f.raw.prepare('SELECT id FROM retained_browser_sets ORDER BY id').all()).toEqual([{ id: 'one' }, { id: 'two' }])
  })

  it('resets at the exact epoch-aligned boundary, never on backwards time', async () => {
    const f = fixture()
    f.grant()
    await f.store.bootstrap(browser('one'), 119)
    await f.store.bootstrap(browser('two'), 119)
    await f.store.createPending(pending('p1', 'one'), 119)
    await f.store.createPending(pending('p2', 'two'), 119)
    const before = f.snapshot()
    await expect(f.store.bootstrap(browser('three'), 119)).rejects.toThrow('retained-rate-limit')
    await expect(f.store.createPending(pending('p3', 'one', 'gate', 1), 119)).rejects.toThrow('retained-rate-limit')
    expect(f.snapshot()).toEqual(before)
    expect(await f.store.bootstrap(browser('three'), 120)).toBe(true)
    expect(await f.store.createPending(pending('p3', 'three'), 120)).toEqual({ browserSetId: 'three', sessionId: null, version: 1 })
    const rolled = f.snapshot()
    await expect(f.store.bootstrap(browser('four'), 119)).rejects.toThrow('retained-rate-limit')
    await expect(f.store.createPending(pending('p4', 'one', 'gate', 1), 119)).rejects.toThrow('retained-rate-limit')
    expect(f.snapshot()).toEqual(rolled)
    expect(f.counters()).toEqual([
      { gate_id: 'gate', kind: 'bootstrap', window_start: 120, used: 1, stage: 1 },
      { gate_id: 'gate', kind: 'pending', window_start: 120, used: 1, stage: 1 },
    ])
  })

  it('isolates trusted gates and kinds, including pending allocations on new handles', async () => {
    const f = fixture({ gateBootstrapsPerWindow: 3 })
    f.grant()
    for (const gate of ['a', 'b']) {
      for (const id of ['one', 'two']) {
        const b = `${gate}-${id}`
        expect(await f.store.bootstrap(browser(b, gate), 100)).toBe(true)
        expect(await f.store.createPending(pending(`p-${b}`, b, gate), 100)).toEqual({ browserSetId: b, sessionId: null, version: 1 })
      }
    }
    // A later browser allocation does not reset the still-current pending window.
    const another = d1RetainedStore(f.db, { ...LIMITS, gateBootstrapsPerWindow: 3 })
    await another.bootstrap(browser('fresh', 'a'), 100)
    const before = f.snapshot()
    await expect(another.createPending(pending('fresh-p', 'fresh', 'a'), 100)).rejects.toThrow('retained-rate-limit')
    await expect(another.bootstrap(browser('fourth', 'a'), 100)).rejects.toThrow('retained-rate-limit')
    expect(f.snapshot()).toEqual(before)
    expect(f.counters()).toEqual([
      { gate_id: 'a', kind: 'bootstrap', window_start: 60, used: 3, stage: 1 },
      { gate_id: 'a', kind: 'pending', window_start: 60, used: 2, stage: 1 },
      { gate_id: 'b', kind: 'bootstrap', window_start: 60, used: 2, stage: 1 },
      { gate_id: 'b', kind: 'pending', window_start: 60, used: 2, stage: 1 },
    ])
  })

  it('competing adapters cannot exceed either allowance', async () => {
    const f = fixture({ gateBootstrapsPerWindow: 3 })
    f.grant()
    const other = d1RetainedStore(f.db, { ...LIMITS, gateBootstrapsPerWindow: 3 })
    const bootstrap = await Promise.allSettled(Array.from({ length: 8 }, (_, n) => (n % 2 ? other : f.store).bootstrap(browser(`b${n}`), 100)))
    expect(bootstrap.map(result => result.status).sort()).toEqual([
      'fulfilled', 'fulfilled', 'fulfilled', 'rejected', 'rejected', 'rejected', 'rejected', 'rejected',
    ])
    expect(bootstrap.filter(result => result.status === 'rejected').map(result => result.reason.code)).toEqual(Array(5).fill('retained-rate-limit'))
    const incoming = await Promise.allSettled(['b0', 'b1', 'b2'].map((b, n) => (n % 2 ? other : f.store).createPending(pending(`p${n}`, b), 100)))
    expect(incoming.map(result => result.status).sort()).toEqual(['fulfilled', 'fulfilled', 'rejected'])
    expect(incoming.filter(result => result.status === 'rejected').map(result => result.reason.code)).toEqual(['retained-rate-limit'])
    expect(f.raw.prepare('SELECT id FROM retained_pending ORDER BY id').all()).toEqual([{ id: 'p0' }, { id: 'p1' }])
    expect(f.counters()).toEqual([
      { gate_id: 'gate', kind: 'bootstrap', window_start: 60, used: 3, stage: 1 },
      { gate_id: 'gate', kind: 'pending', window_start: 60, used: 2, stage: 1 },
    ])
  })

  it('a competing stale CAS returns null and cannot debit pending admission', async () => {
    const f = fixture()
    f.grant()
    await f.store.bootstrap(browser('one'), 100)
    expect(await Promise.all([
      f.store.createPending(pending('p1', 'one'), 100), f.store.createPending(pending('p2', 'one'), 100),
    ])).toEqual([{ browserSetId: 'one', sessionId: null, version: 1 }, null])
    expect(f.counters()).toEqual([
      { gate_id: 'gate', kind: 'bootstrap', window_start: 60, used: 1, stage: 1 },
      { gate_id: 'gate', kind: 'pending', window_start: 60, used: 1, stage: 1 },
    ])
  })

  it('hard storage includes expired rows and wins over simultaneous rate pressure', async () => {
    const f = fixture({ gateBrowserSets: 1, gatePending: 1, gateBootstrapsPerWindow: 1, gatePendingsPerWindow: 1 })
    f.grant()
    await f.store.bootstrap(browser('one'), 100)
    await f.store.createPending(pending('p1', 'one'), 100)
    f.raw.exec('UPDATE retained_pending SET expires_at = 100')
    const before = f.snapshot()
    expect(await pressure(f.store.bootstrap(browser('two'), 100))).toEqual({ code: 'retained-storage-capacity', status: 503 })
    expect(await pressure(f.store.createPending(pending('p2', 'one', 'gate', 1), 100))).toEqual({ code: 'retained-storage-capacity', status: 503 })
    expect(f.snapshot()).toEqual(before)
    f.raw.exec('UPDATE retained_browser_sets SET expires_at = 100')
    const expired = f.snapshot()
    await expect(f.store.bootstrap(browser('two'), 120)).rejects.toThrow('retained-storage-capacity')
    expect(f.snapshot()).toEqual(expired)
  })

  it.each([
    ['stale selection', { expected: { browserSetId: 'one', sessionId: null, version: 0 } }],
    ['wrong gate', { gateId: 'other' }],
    ['wrong handle', { handleHash: 'wrong' }],
    ['wrong grant proof', { tokenHash: 'wrong' }],
  ])('%s leaves every row untouched, even during global pressure', async (_label, patch) => {
    const f = fixture({ gatePendingsPerWindow: 1 })
    f.grant()
    await f.store.bootstrap(browser('one'), 100)
    await f.store.createPending(pending('p1', 'one'), 100)
    const before = f.snapshot()
    expect(await f.store.createPending({ ...pending('p2', 'one', 'gate', 1), ...patch }, 100)).toBeNull()
    expect(f.snapshot()).toEqual(before)
  })

  it('per-browser pending capacity remains null/409 with no rate debit', async () => {
    const f = fixture({ pending: 1, gatePendingsPerWindow: 1, gatePending: 1 })
    f.grant()
    await f.store.bootstrap(browser('one'), 100)
    await f.store.createPending(pending('p1', 'one'), 100)
    const before = f.snapshot()
    expect(await f.store.createPending(pending('p2', 'one', 'gate', 1), 100)).toBeNull()
    expect(f.snapshot()).toEqual(before)
  })

  it('cleanup and ended browsers never erase allowance; many windows retain exactly two counter rows', async () => {
    const f = fixture({ browserTtlS: 1, pendingTtlS: 1 })
    f.grant()
    for (let n = 1; n <= 50; n++) {
      const now = n * 60
      const b = `b${n}`
      await f.store.bootstrap(browser(b), now)
      await f.store.createPending(pending(`p${n}`, b), now)
      expect(await f.store.cleanup(now + 1)).toBe(2)
    }
    expect(f.counters()).toEqual([
      { gate_id: 'gate', kind: 'bootstrap', window_start: 3000, used: 1, stage: 1 },
      { gate_id: 'gate', kind: 'pending', window_start: 3000, used: 1, stage: 1 },
    ])
    expect(f.raw.prepare('SELECT * FROM retained_browser_sets').all()).toEqual([])
    await f.store.bootstrap(browser('fresh'), 3001)
    expect(await f.store.endBrowser(browser('fresh'), 3001)).toBe(true)
    expect(await f.store.cleanup(3001)).toBe(1)
    const before = f.snapshot()
    await expect(f.store.bootstrap(browser('again'), 3001)).rejects.toThrow('retained-rate-limit')
    expect(f.snapshot()).toEqual(before)
  })

  it('uses finite defaults when the three overrides are omitted', async () => {
    const f = fixture()
    const { admissionWindowS: _window, gateBootstrapsPerWindow: _bootstrap, gatePendingsPerWindow: _pending, ...limits } = LIMITS
    const store = d1RetainedStore(f.db, { ...limits, gateBrowserSets: 200, gatePending: 300, pending: 300 })
    f.grant()
    for (let n = 0; n < 120; n++) await store.bootstrap(browser(`b${n}`), 119)
    await expect(store.bootstrap(browser('excess'), 119)).rejects.toThrow('retained-rate-limit')
    for (let n = 0; n < 240; n++) await store.createPending(pending(`p${n}`, 'b0', 'gate', n), 119)
    await expect(store.createPending(pending('excess', 'b0', 'gate', 240), 119)).rejects.toThrow('retained-rate-limit')
    expect(f.counters()).toEqual([
      { gate_id: 'gate', kind: 'bootstrap', window_start: 60, used: 120, stage: 1 },
      { gate_id: 'gate', kind: 'pending', window_start: 60, used: 240, stage: 1 },
    ])
  })

  it.each(['admissionWindowS', 'gateBootstrapsPerWindow', 'gatePendingsPerWindow'] as const)('validates %s as a positive safe integer', key => {
    const f = fixture()
    for (const value of [undefined, null, '2', NaN, 0, -0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => d1RetainedStore(f.db, { ...LIMITS, [key]: value } as RetainedLimits)).toThrow('Invalid retained integer')
    }
    expect(() => d1RetainedStore(f.db, { ...LIMITS, [key]: Number.MAX_SAFE_INTEGER })).not.toThrow()
  })

  it('rejects invalid time/expiry arithmetic before any write', async () => {
    const f = fixture()
    const before = f.snapshot()
    for (const now of [-0, -1, NaN, 1.5, Infinity, Number.MAX_SAFE_INTEGER]) {
      await expect(f.store.bootstrap(browser('one'), now)).rejects.toThrow('Invalid retained integer')
      await expect(f.store.createPending(pending('p1', 'one'), now)).rejects.toThrow('Invalid retained integer')
    }
    expect(f.snapshot()).toEqual(before)
  })
})

const request = (path: string, cookie = '', body?: unknown) => new Request(`https://app.test${path}`, {
  method: body === undefined ? 'GET' : 'POST', headers: { cookie, 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
})
const gateFor = (f: ReturnType<typeof fixture>) => createGate({
  store: d1GrantStore(f.db), secret: 'test-secret-not-a-production-credential',
  policy: async () => ['read'], retained: { store: f.store, gateId: 'gate' },
})
async function emailProof(db: D1Database) {
  await d1PendingAuthStore(db).insert({
    id: 'email-proof', email: 'ann@example.test', tokenHash: await hashToken('email-token'),
    codeHash: await hashToken('ann@example.test:123456'), createdAt: 100, expiresAt: 700,
    consumedAt: null, attempts: 0, ipHash: null,
  })
}

describe('retained HTTP pressure mapping before proof consumption', () => {
  it.each([
    ['rate', { gateBootstrapsPerWindow: 1 }, 429, 'retained-rate-limit'],
    ['storage', { gateBrowserSets: 1 }, 503, 'retained-storage-capacity'],
  ] as const)('bootstrap %s pressure preserves email proof and grant redemptions', async (_label, limits, status, error) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(100_000)
    const f = fixture(limits)
    const gate = gateFor(f)
    const route = authRoutes(gate)
    f.grant(await hashToken('share-token'))
    await emailProof(f.db)
    await f.store.bootstrap(browser('reserved'), 100)
    const flow = emailCodeAuth({ gate, store: d1PendingAuthStore(f.db), from: 'test@example.test',
      nowMs: () => 100_000, linkFor: token => `https://app.test/link?token=${token}`,
      send: async () => { throw new Error('Verification must not send mail') } })
    const before = f.snapshot()
    const exchange = (await route(request('/api/auth/exchange', '', { token: 'share-token' })))!
    expect([exchange.status, await exchange.json(), exchange.headers.get('set-cookie')]).toEqual([status, { error }, null])
    expect(f.snapshot()).toEqual(before)
    const code = await flow.verifyCode({ request: request('/email/code', '', { id: 'email-proof', code: '123456' }) })
    expect([code.status, await code.json(), code.headers.get('set-cookie')]).toEqual([status, { ok: false, error }, null])
    expect(f.snapshot()).toEqual(before)
    const link = await flow.verifyLink({ request: request('/email/link?token=email-token') })
    expect([link.status, await link.json(), link.headers.get('set-cookie')]).toEqual([status, { ok: false, error }, null])
    expect(f.snapshot()).toEqual(before)
  })

  it.each([
    ['rate', { gatePendingsPerWindow: 1 }, 429, 'retained-rate-limit'],
    ['storage', { gatePending: 1 }, 503, 'retained-storage-capacity'],
    ['per-browser capacity', { pending: 1, gatePending: 1, gatePendingsPerWindow: 1 }, 409, 'pending-link-capacity'],
  ] as const)('pending %s preserves the selected email, incoming proof and redemption', async (_label, limits, status, error) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(100_000)
    const f = fixture(limits)
    const gate = gateFor(f)
    const route = authRoutes(gate)
    f.grant(await hashToken('share-token'))
    await emailProof(f.db)
    const signed = await gate.signIn('ann@example.test', request('/login'))
    const cookie = signed!.cookies[0]!.split(';')[0]!
    const incoming = await gate.redeem('share-token', request('/share', cookie))
    expect([incoming.ok, (await d1GrantStore(f.db).byId('grant'))!.redeems]).toEqual([true, 0])
    const before = f.snapshot()
    const refused = (await route(request('/api/auth/exchange', cookie, { token: 'share-token' })))!
    expect([refused.status, await refused.json(), refused.headers.get('set-cookie')]).toEqual([status, { error }, null])
    expect(f.snapshot()).toEqual(before)
  })

  it('an existing browser can still complete email proof when global allocation admission is full', async () => {
    const f = fixture({ gateBootstrapsPerWindow: 1, gateBrowserSets: 1 })
    const gate = gateFor(f)
    const signed = await gate.signIn('bob@example.test', request('/login'), 100_000)
    const cookie = signed!.cookies[0]!.split(';')[0]!
    await emailProof(f.db)
    const counters = f.counters()
    expect((await gate.signIn('ann@example.test', request('/login', cookie), 100_000, {
      pendingId: 'email-proof', email: 'ann@example.test', kind: 'code', hash: await hashToken('ann@example.test:123456'), maxAttempts: 5,
    }))!.cookies.length).toBe(1)
    expect(f.counters()).toEqual(counters)
    expect((await d1PendingAuthStore(f.db).byId('email-proof'))!.consumedAt).toBe(100)
    expect((await gate.retained!.accounts(request('/accounts', cookie), 100_000))!.accounts.map(a => [a.email, a.active])).toEqual([
      ['bob@example.test', false], ['ann@example.test', true],
    ])
  })
})

describe('allocation and admission roll back together', () => {
  it.each(Array.from({ length: 5 }, (_, n) => n))('bootstrap fault at statement %i changes no rows', async index => {
    const f = fixture()
    const before = f.snapshot()
    f.fail(index)
    await expect(f.store.bootstrap(browser('one'), 100)).rejects.toThrow(`Injected batch failure at ${index}`)
    expect(f.snapshot()).toEqual(before)
  })

  it.each(Array.from({ length: 8 }, (_, n) => n))('pending fault at statement %i restores debit, proof and selection', async index => {
    const f = fixture()
    f.grant()
    await f.store.bootstrap(browser('one'), 100)
    const before = f.snapshot()
    f.fail(index)
    await expect(f.store.createPending(pending('p1', 'one'), 100)).rejects.toThrow(`Injected batch failure at ${index}`)
    expect(f.snapshot()).toEqual(before)
  })

  it.each([
    ['browser insertion', 'INSERT', 'retained_browser_sets', '', 'bootstrap'],
    ['pending insertion', 'INSERT', 'retained_pending', '', 'pending'],
    ['pending selection CAS', 'UPDATE', 'retained_browser_sets', '', 'pending'],
    ['pending readiness', 'UPDATE', 'retained_pending', '', 'pending'],
    ['bootstrap debit finalization', 'UPDATE', 'retained_admission', 'WHEN NEW.stage = 1', 'bootstrap'],
    ['pending debit finalization', 'UPDATE', 'retained_admission', 'WHEN NEW.stage = 1', 'pending'],
  ])('zero-row %s cannot leave a debit or allocation', async (_label, event, table, when, kind) => {
    const f = fixture()
    f.grant()
    await f.store.bootstrap(browser('one'), 100)
    f.raw.exec(`CREATE TRIGGER skip BEFORE ${event} ON ${table} ${when} BEGIN SELECT RAISE(IGNORE); END`)
    const before = f.snapshot()
    await expect(kind === 'bootstrap' ? f.store.bootstrap(browser('two'), 100) : f.store.createPending(pending('p1', 'one'), 100)).rejects.toThrow()
    expect(f.snapshot()).toEqual(before)
  })

  it.each(['bootstrap', 'pending'] as const)('a skipped %s counter claim never allocates', async kind => {
    const f = fixture()
    f.grant()
    await f.store.bootstrap(browser('one'), 100)
    f.raw.exec(`CREATE TRIGGER skip BEFORE INSERT ON retained_admission BEGIN SELECT RAISE(IGNORE); END`)
    const before = f.snapshot()
    await expect(kind === 'bootstrap' ? f.store.bootstrap(browser('two'), 100) : f.store.createPending(pending('p1', 'one'), 100)).rejects.toThrow(
      kind === 'bootstrap' ? 'Browser allocation did not commit' : 'Pending allocation did not commit',
    )
    expect(f.snapshot()).toEqual(before)
  })

  it('selector collisions roll back the counter rather than counting failed allocations', async () => {
    const f = fixture()
    f.grant()
    await f.store.bootstrap(browser('one'), 100)
    const before = f.snapshot()
    await expect(f.store.bootstrap(browser('one'), 100)).rejects.toThrow('UNIQUE constraint failed')
    expect(f.snapshot()).toEqual(before)
    await f.store.createPending(pending('p1', 'one'), 100)
    const allocated = f.snapshot()
    await expect(f.store.createPending(pending('p1', 'one', 'gate', 1), 100)).rejects.toThrow('UNIQUE constraint failed')
    expect(f.snapshot()).toEqual(allocated)
  })
})

it.runIf(process.env.OA_D1_RUNTIME === '1')('local workerd/D1 proves admission concurrency, boundaries and transaction rollback', async () => {
  const require = createRequire(realpathSync(fileURLToPath(new URL('../demo/node_modules/wrangler/package.json', import.meta.url).href)))
  const { Miniflare, convertV4MiniflareOptions } = require('miniflare') as {
    convertV4MiniflareOptions(options: Record<string, unknown>): Record<string, unknown>
    Miniflare: new (options: Record<string, unknown>) => {
      getD1Database(name: string): Promise<D1Database>
      dispose(): Promise<void>
    }
  }
  const runtime = new Miniflare(convertV4MiniflareOptions({
    host: '127.0.0.1', port: 0, inspectorPort: 0, modules: true,
    script: 'export default { fetch() { return new Response("local retained admission test") } }',
    compatibilityDate: '2026-08-11', d1Databases: { DB: 'retained-admission-test' },
  }))
  try {
    const f = fixture()
    const db = await runtime.getD1Database('DB')
    const schema = f.raw.prepare(`SELECT sql FROM sqlite_master
      WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid`).all()
    await db.batch(schema.map(row => db.prepare(String(row.sql))))
    await db.prepare(`INSERT INTO grants (id, token_hash, scopes, created_at, created_by, max_redeems)
      VALUES ('grant', 'proof-hash', 'read', 1, 'admin', 1)`).run()
    await emailProof(db)
    const snapshot = async () => {
      const tables = ['grants', 'pending_auth', 'retained_browser_sets', 'retained_pending', 'retained_sessions', 'retained_operations', 'retained_admission']
      const rows = await db.batch(tables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`)))
      return Object.fromEntries(tables.map((table, index) => [table, rows[index]!.results]))
    }
    const limits = { ...LIMITS, gateBootstrapsPerWindow: 4 }
    const store = d1RetainedStore(db, limits)
    const competing = d1RetainedStore(db, limits)
    const allocations = await Promise.allSettled(Array.from({ length: 8 }, (_, n) =>
      (n % 2 ? store : competing).bootstrap(browser(`b${n}`), 100)))
    expect(allocations.map(result => result.status === 'fulfilled' ? result.value : result.reason.code).sort()).toEqual([
      'retained-rate-limit', 'retained-rate-limit', 'retained-rate-limit', 'retained-rate-limit', true, true, true, true,
    ].sort())
    const browsers = (await db.prepare('SELECT id FROM retained_browser_sets ORDER BY id').all<{ id: string }>()).results
    const pendings = await Promise.allSettled(browsers.map((b, n) => (n % 2 ? store : competing).createPending(pending(`p${n}`, b.id), 100)))
    expect(pendings.map(result => result.status).sort()).toEqual(['fulfilled', 'fulfilled', 'rejected', 'rejected'])
    expect(pendings.filter(result => result.status === 'rejected').map(result => result.reason.code)).toEqual(['retained-rate-limit', 'retained-rate-limit'])
    const first = browsers[0]!.id
    const b = (await store.browser(browser(first), 100))!
    const before = await snapshot()
    await expect(store.bootstrap(browser('boundary'), 119)).rejects.toThrow('retained-rate-limit')
    await expect(store.createPending(pending('boundary-p', first, 'gate', b.version), 119)).rejects.toThrow('retained-rate-limit')
    expect(await snapshot()).toEqual(before)
    expect(await store.bootstrap(browser('boundary'), 120)).toBe(true)
    expect(await store.createPending(pending('boundary-p', 'boundary'), 120)).toEqual({ browserSetId: 'boundary', sessionId: null, version: 1 })
    const rolled = await snapshot()
    await expect(store.bootstrap(browser('backwards'), 119)).rejects.toThrow('retained-rate-limit')
    await expect(store.createPending(pending('backwards-p', first, 'gate', b.version), 119)).rejects.toThrow('retained-rate-limit')
    expect(await snapshot()).toEqual(rolled)
    expect((await db.prepare(`SELECT gate_id, kind, window_start, used, stage FROM retained_admission ORDER BY gate_id, kind`).all()).results).toEqual([
      { gate_id: 'gate', kind: 'bootstrap', window_start: 120, used: 1, stage: 1 },
      { gate_id: 'gate', kind: 'pending', window_start: 120, used: 1, stage: 1 },
    ])
    const small = d1RetainedStore(db, { ...LIMITS, gateBrowserSets: 1, gatePending: 1, gateBootstrapsPerWindow: 1, gatePendingsPerWindow: 1 })
    await small.bootstrap(browser('small', 'small'), 120)
    await small.createPending(pending('small-p', 'small', 'small'), 120)
    const full = await snapshot()
    expect(await pressure(small.bootstrap(browser('small-extra', 'small'), 120))).toEqual({ code: 'retained-storage-capacity', status: 503 })
    expect(await pressure(small.createPending(pending('small-p2', 'small', 'small', 1), 120))).toEqual({ code: 'retained-storage-capacity', status: 503 })
    expect(await snapshot()).toEqual(full)

    for (const [event, table, when, kind] of [
      ['INSERT', 'retained_browser_sets', '', 'bootstrap'],
      ['INSERT', 'retained_pending', '', 'pending'],
      ['UPDATE', 'retained_browser_sets', '', 'pending'],
      ['UPDATE', 'retained_pending', '', 'pending'],
      ['UPDATE', 'retained_admission', 'WHEN NEW.stage = 1', 'bootstrap'],
      ['UPDATE', 'retained_admission', 'WHEN NEW.stage = 1', 'pending'],
    ]) {
      await db.prepare(`CREATE TRIGGER skip BEFORE ${event} ON ${table} ${when} BEGIN SELECT RAISE(IGNORE); END`).run()
      const before = await snapshot()
      await expect(kind === 'bootstrap'
        ? store.bootstrap(browser('fault'), 120)
        : store.createPending(pending('fault-p', 'boundary', 'gate', 1), 120)).rejects.toThrow()
      expect(await snapshot()).toEqual(before)
      await db.prepare('DROP TRIGGER skip').run()
    }
    for (const kind of ['bootstrap', 'pending']) {
      for (let index = 0; index < (kind === 'bootstrap' ? 5 : 8); index++) {
        const faulty = { prepare: db.prepare.bind(db), batch: (statements: D1PreparedStatement[]) => db.batch(
          statements.map((statement, n) => n === index ? db.prepare('SELECT * FROM nonexistent_admission_fault') : statement),
        ) } as unknown as D1Database
        const failedStore = d1RetainedStore(faulty, limits)
        const before = await snapshot()
        await expect(kind === 'bootstrap'
          ? failedStore.bootstrap(browser('fault'), 120)
          : failedStore.createPending(pending('fault-p', 'boundary', 'gate', 1), 120)).rejects.toThrow('no such table: nonexistent_admission_fault')
        expect(await snapshot()).toEqual(before)
      }
    }
  } finally {
    await runtime.dispose()
  }
}, 60_000)
