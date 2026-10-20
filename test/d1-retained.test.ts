import { readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { d1RetainedStore } from '../src/adapters/d1-retained.js'
import type { CommitIncoming, PendingIncoming, RetainedBinding, RetainedLimits } from '../src/core/retained-store.js'

const limits: RetainedLimits = {
  sessions: 8, pending: 4, gateBrowserSets: 20, gatePending: 40,
  browserTtlS: 2592000, pendingTtlS: 600, retryTtlS: 86400, defaultSessionTtlS: 3600,
}
const browser: RetainedBinding = { gateId: 'gate', browserSetId: 'browser', handleHash: 'keyed-handle-hash' }
const databases: DatabaseSync[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })

/** Local shim intentionally independent of shared test/d1-shim.ts. Every SQL
 * statement runs on real SQLite; a batch is synchronous BEGIN/COMMIT/ROLLBACK,
 * including result reads. No JS awaits allow other batches inside its boundary.
 */
function fixture(overrides: Partial<RetainedLimits> = {}) {
  const sqlite = new DatabaseSync(':memory:')
  databases.push(sqlite)
  sqlite.exec('PRAGMA foreign_keys = ON')
  for (const name of ['0001_init.sql', '0002_access_log_location.sql', '0003_retained_logins.sql']) {
    sqlite.exec(readFileSync(fileURLToPath(new URL(`../migrations/${name}`, import.meta.url).href), 'utf8'))
  }
  const executions = new WeakMap<D1PreparedStatement, () => D1Result>()
  let failAt: number | null = null
  const prepare = (text: string, args: (string | number | null)[] = []): D1PreparedStatement => {
    const execute = () => {
      const results = sqlite.prepare(text).all(...args)
      const changes = Number(sqlite.prepare('SELECT changes() AS n').get()!.n)
      return { success: true, results, meta: { changes } } as D1Result
    }
    const statement = {
      bind: (...values: (string | number | null)[]) => prepare(text, values),
      first: async () => sqlite.prepare(text).get(...args) ?? null,
      all: async () => execute(),
      run: async () => execute(),
      raw: async () => { throw new Error('Unused shim method') },
    } as unknown as D1PreparedStatement
    executions.set(statement, execute)
    return statement
  }
  const db = {
    prepare,
    batch: async (statements: D1PreparedStatement[]) => {
      sqlite.exec('BEGIN IMMEDIATE')
      try {
        const results = statements.map((statement, index) => {
          if (index === failAt) throw new Error(`Injected batch failure at ${index}`)
          return executions.get(statement)!()
        })
        sqlite.exec('COMMIT')
        return results
      } catch (error) {
        sqlite.exec('ROLLBACK')
        throw error
      }
    },
  } as unknown as D1Database
  const store = d1RetainedStore(db, { ...limits, ...overrides })
  const rows = (table: string) => sqlite.prepare(`SELECT * FROM ${table} ORDER BY id`).all()
  const snapshot = () => Object.fromEntries([
    'grants', 'retained_browser_sets', 'retained_pending', 'retained_sessions', 'retained_operations',
  ].map(table => [table, rows(table)]))
  const grant = (id = 'grant', tokenHash = 'token-hash') => {
    sqlite.prepare(`INSERT INTO grants (id, token_hash, scopes, created_at, created_by, max_redeems)
      VALUES (?, ?, 'read', 1, 'admin', 1)`).run(id, tokenHash)
  }
  const create = async (suffix = '', bound = browser, version = 0): Promise<CommitIncoming> => {
    const input: PendingIncoming = {
      ...bound, expected: { browserSetId: bound.browserSetId, sessionId: null, version },
      pendingId: `pending${suffix}`, grantId: 'grant', tokenHash: 'token-hash',
    }
    const context = await store.createPending(input, 100)
    expect(context).toEqual({ browserSetId: bound.browserSetId, sessionId: null, version: version + 1 })
    return { ...input, expected: context!, operationId: `operation${suffix}`, newSessionId: `session${suffix}`, select: true }
  }
  return { sqlite, db, store, rows, snapshot, grant, create, fail: (index: number) => { failAt = index } }
}

async function ready(overrides: Partial<RetainedLimits> = {}) {
  const f = fixture(overrides)
  f.grant()
  expect(await f.store.bootstrap(browser, 100)).toBe(true)
  const input = await f.create()
  return { ...f, input }
}

describe('optional D1 retained incoming completion', () => {
  it('bootstraps only an empty set; pending proof changes version but never redeems', async () => {
    const f = await ready()
    expect(f.rows('retained_browser_sets')).toEqual([{
      id: 'browser', gate_id: 'gate', handle_hash: 'keyed-handle-hash', active_session_id: null,
      selection_version: 1, created_at: 100, expires_at: 2592100,
    }])
    expect(f.rows('retained_pending')).toEqual([{
      id: 'pending', browser_set_id: 'browser', gate_id: 'gate', grant_id: 'grant', token_hash: 'token-hash',
      expires_at: 700, consumed_operation_id: null, ready: 1,
    }])
    expect(f.rows('retained_sessions')).toEqual([])
    expect(f.rows('retained_operations')).toEqual([])
    expect(f.rows('grants').map(g => [g.redeems, g.first_used_at, g.last_used_at])).toEqual([[0, null, null]])
  })

  it('commits proof, CAS redemption, session, selection, and recorded result together', async () => {
    const f = await ready()
    expect(await f.store.commitIncoming(f.input, 101)).toEqual({ sessionId: 'session', committedVersion: 2 })
    expect(f.rows('retained_sessions')).toEqual([{
      id: 'session', browser_set_id: 'browser', grant_id: 'grant', issued_at: 101, expires_at: 3701, revoked_at: null,
    }])
    expect(f.rows('grants').map(g => [g.redeems, g.first_used_at, g.last_used_at])).toEqual([[1, 101, 101]])
    expect(f.rows('retained_pending').map(p => [p.id, p.consumed_operation_id])).toEqual([['pending', 'operation']])
    expect(f.rows('retained_browser_sets').map(b => [b.active_session_id, b.selection_version])).toEqual([['session', 2]])
    const operations = f.rows('retained_operations')
    expect(operations.map(o => ({ ...o, attempt_id: '<attempt>' }))).toEqual([{
      id: 'operation', browser_set_id: 'browser', gate_id: 'gate',
      input_json: JSON.stringify(['gate', 'browser', 'keyed-handle-hash', 'pending', 'grant', 'token-hash', null, 1, 'session', true]),
      attempt_id: '<attempt>', session_id: 'session', minted: 1, committed_version: 2, expires_at: 86501, stage: 5,
    }])
    expect(typeof operations[0]!.attempt_id).toBe('string')
  })

  it('exact concurrent retries redeem once and do not reselect after a later change', async () => {
    const f = await ready()
    expect(await Promise.all([f.store.commitIncoming(f.input, 101), f.store.commitIncoming(f.input, 101)])).toEqual([
      { sessionId: 'session', committedVersion: 2 }, { sessionId: 'session', committedVersion: 2 },
    ])
    // Simulate a later independent selection transaction, not an API offered here.
    f.sqlite.exec('UPDATE retained_browser_sets SET active_session_id = NULL, selection_version = 3')
    const before = f.snapshot()
    expect(await f.store.commitIncoming(f.input, 800)).toEqual({ sessionId: 'session', committedVersion: 2 })
    expect(f.snapshot()).toEqual(before)
    expect(f.rows('grants').map(g => g.redeems)).toEqual([1])
  })

  it.each([
    { handleHash: 'wrong' }, { gateId: 'wrong' },
    { browserSetId: 'other', expected: { browserSetId: 'other', sessionId: null, version: 1 } },
    { newSessionId: 'different' }, { pendingId: 'different' }, { grantId: 'different' },
    { tokenHash: 'different' }, { select: false },
    { expected: { browserSetId: 'browser', sessionId: null, version: 2 } },
    { expected: { browserSetId: 'browser', sessionId: 'different', version: 1 } },
  ])('cannot recover/reuse an operation with different bound input: %j', async patch => {
    const f = await ready()
    expect(await f.store.commitIncoming(f.input, 101)).toEqual({ sessionId: 'session', committedVersion: 2 })
    const before = f.snapshot()
    expect(await f.store.commitIncoming({ ...f.input, ...patch }, 102)).toBeNull()
    expect(f.snapshot()).toEqual(before)
  })

  it('a different browser with its own valid proof cannot reuse an operation ID', async () => {
    const f = await ready()
    expect(await f.store.commitIncoming(f.input, 101)).toEqual({ sessionId: 'session', committedVersion: 2 })
    const other = { gateId: 'other-gate', browserSetId: 'other', handleHash: 'other-hash' }
    expect(await f.store.bootstrap(other, 100)).toBe(true)
    const input = await f.create('-other', other)
    const before = f.snapshot()
    expect(await f.store.commitIncoming({ ...input, operationId: 'operation' }, 102)).toBeNull()
    expect(f.snapshot()).toEqual(before)
  })

  it('expired retry records fail closed, never become fresh completions', async () => {
    const f = await ready()
    expect(await f.store.commitIncoming(f.input, 101)).toEqual({ sessionId: 'session', committedVersion: 2 })
    const before = f.snapshot()
    expect(await f.store.commitIncoming(f.input, 86501)).toBeNull()
    expect(f.snapshot()).toEqual(before)
  })

  it.each([
    "UPDATE grants SET disabled_at = 101",
    "UPDATE grants SET revoked_at = 101",
    "UPDATE grants SET expires_at = 101",
    "UPDATE grants SET redeems = max_redeems",
    "UPDATE grants SET token_hash = 'rotated'",
    "UPDATE grants SET sessions_invalid_before = 102",
    "UPDATE grants SET session_ttl = 0",
    "UPDATE grants SET session_ttl = 9007199254740991",
    "UPDATE retained_pending SET expires_at = 101",
    "UPDATE retained_pending SET consumed_operation_id = 'spent'",
    "UPDATE retained_pending SET token_hash = 'forged'",
    "UPDATE retained_pending SET gate_id = 'wrong'",
    "UPDATE retained_browser_sets SET expires_at = 101",
    "UPDATE retained_browser_sets SET selection_version = 2",
    "UPDATE retained_browser_sets SET active_session_id = 'other'",
    "UPDATE retained_browser_sets SET handle_hash = 'rotated'",
  ])('initial zero-row guard is a complete no-op: %s', async change => {
    const f = await ready()
    f.sqlite.exec(change)
    const before = f.snapshot()
    expect(await f.store.commitIncoming(f.input, 101)).toBeNull()
    expect(f.snapshot()).toEqual(before)
  })

  it('refuses version exhaustion without spending proof', async () => {
    const f = await ready()
    f.sqlite.exec('UPDATE retained_browser_sets SET selection_version = 9007199254740991')
    const before = f.snapshot()
    expect(await f.store.commitIncoming({ ...f.input, expected: { ...f.input.expected, version: Number.MAX_SAFE_INTEGER } }, 101)).toBeNull()
    expect(f.snapshot()).toEqual(before)
  })

  it('keeps the current actor when retention without selection is explicit', async () => {
    const f = await ready()
    f.sqlite.exec("UPDATE retained_browser_sets SET active_session_id = 'member'")
    const input = { ...f.input, expected: { ...f.input.expected, sessionId: 'member' }, select: false }
    expect(await f.store.commitIncoming(input, 101)).toEqual({ sessionId: 'session', committedVersion: 2 })
    expect(f.rows('retained_browser_sets').map(b => [b.active_session_id, b.selection_version])).toEqual([['member', 2]])
    expect(f.rows('retained_sessions').map(s => s.id)).toEqual(['session'])
  })

  it('capacity is checked at the authoritative insert boundary', async () => {
    const f = await ready({ sessions: 1 })
    f.sqlite.exec(`INSERT INTO retained_sessions VALUES ('prior', 'browser', 'grant', 90, 1000, NULL)`)
    // A different grant cannot use the prior session's slot or identity.
    f.grant('second', 'second-hash')
    f.sqlite.exec("UPDATE retained_pending SET grant_id = 'second', token_hash = 'second-hash'")
    const before = f.snapshot()
    expect(await f.store.commitIncoming({ ...f.input, grantId: 'second', tokenHash: 'second-hash' }, 101)).toBeNull()
    expect(f.snapshot()).toEqual(before)
  })

  it.each([
    'disabled_at = 101', 'redeems = max_redeems',
    'expires_at = 101, expiry_ends_sessions = 0',
    'sessions_invalid_before = 90',
  ])('reuses still-valid evidence at capacity without redeeming: %s', async change => {
    const f = await ready({ sessions: 1 })
    f.sqlite.exec(`INSERT INTO retained_sessions VALUES ('existing', 'browser', 'grant', 90, 1000, NULL)`)
    f.sqlite.exec(`UPDATE grants SET ${change}`)
    const grantsBefore = f.rows('grants')
    expect(await f.store.commitIncoming(f.input, 101)).toEqual({ sessionId: 'existing', committedVersion: 2 })
    expect(f.rows('grants')).toEqual(grantsBefore)
    expect(f.rows('retained_sessions')).toEqual([{
      id: 'existing', browser_set_id: 'browser', grant_id: 'grant', issued_at: 90, expires_at: 1000, revoked_at: null,
    }])
    expect(f.rows('retained_operations').map(o => [o.session_id, o.minted])).toEqual([['existing', 0]])
  })

  it.each([
    "UPDATE grants SET revoked_at = 101",
    "UPDATE grants SET expires_at = 101, expiry_ends_sessions = 1",
    "UPDATE grants SET sessions_invalid_before = 91",
    "UPDATE grants SET token_hash = 'rotated'",
    "UPDATE retained_sessions SET revoked_at = 101",
    "UPDATE retained_sessions SET expires_at = 101",
  ])('cannot reuse invalid evidence or invalid pending proof: %s', async change => {
    const f = await ready()
    f.sqlite.exec(`INSERT INTO retained_sessions VALUES ('existing', 'browser', 'grant', 90, 1000, NULL)`)
    // Prevent fallback minting so an invalid existing session cannot be renewed.
    f.sqlite.exec('UPDATE grants SET redeems = max_redeems')
    f.sqlite.exec(change)
    const before = f.snapshot()
    expect(await f.store.commitIncoming(f.input, 101)).toBeNull()
    expect(f.snapshot()).toEqual(before)
  })

  it('two browser operations competing for a one-use grant have exactly one winner', async () => {
    const f = await ready()
    const other = { ...browser, browserSetId: 'other', handleHash: 'other-hash' }
    expect(await f.store.bootstrap(other, 100)).toBe(true)
    const second = await f.create('-other', other)
    expect(await Promise.all([f.store.commitIncoming(f.input, 101), f.store.commitIncoming(second, 101)])).toEqual([
      { sessionId: 'session', committedVersion: 2 }, null,
    ])
    expect(f.rows('grants').map(g => g.redeems)).toEqual([1])
    expect(f.rows('retained_pending').map(p => [p.id, p.consumed_operation_id])).toEqual([
      ['pending', 'operation'], ['pending-other', null],
    ])
    expect(f.rows('retained_sessions').map(s => s.id)).toEqual(['session'])
    expect(f.rows('retained_operations').map(o => o.id)).toEqual(['operation'])
    expect(f.rows('retained_browser_sets').map(b => [b.id, b.selection_version])).toEqual([['browser', 2], ['other', 1]])
  })

  it.each([
    ['pending', 'UPDATE', 'retained_pending', ''],
    ['grant CAS', 'UPDATE', 'grants', ''],
    ['session insertion', 'INSERT', 'retained_sessions', ''],
    ['selection CAS', 'UPDATE', 'retained_browser_sets', ''],
    ['operation result', 'UPDATE', 'retained_operations', 'WHEN NEW.stage = 5'],
  ])('zero-row %s rolls back all earlier stages', async (_label, event, table, when) => {
    const f = await ready()
    f.sqlite.exec(`CREATE TRIGGER skip BEFORE ${event} ON ${table} ${when} BEGIN SELECT RAISE(IGNORE); END`)
    const before = f.snapshot()
    await expect(f.store.commitIncoming(f.input, 101)).rejects.toThrow('CHECK constraint failed: stage BETWEEN 0 AND 5')
    expect(f.snapshot()).toEqual(before)
  })

  it('a zero-row operation claim leaves all other writes untouched', async () => {
    const f = await ready()
    f.sqlite.exec('CREATE TRIGGER skip BEFORE INSERT ON retained_operations BEGIN SELECT RAISE(IGNORE); END')
    const before = f.snapshot()
    expect(await f.store.commitIncoming(f.input, 101)).toBeNull()
    expect(f.snapshot()).toEqual(before)
  })

  it.each(Array.from({ length: 12 }, (_, index) => index))('storage fault at batch statement %i rolls back', async index => {
    const f = await ready()
    const before = f.snapshot()
    f.fail(index)
    await expect(f.store.commitIncoming(f.input, 101)).rejects.toThrow(`Injected batch failure at ${index}`)
    expect(f.snapshot()).toEqual(before)
  })

  it('session unique constraint failure rolls back proof and redemption', async () => {
    const f = await ready()
    f.sqlite.exec(`INSERT INTO retained_sessions VALUES ('session', 'browser', 'grant', 90, 100, NULL)`)
    const before = f.snapshot()
    await expect(f.store.commitIncoming(f.input, 101)).rejects.toThrow('UNIQUE constraint failed: retained_sessions.id')
    expect(f.snapshot()).toEqual(before)
  })

  it('bounds bootstrap storage, pending capacity and TTL without extending browser life', async () => {
    const f = fixture({ gateBrowserSets: 1, pending: 1 })
    f.grant()
    f.sqlite.exec('UPDATE grants SET expires_at = 200')
    expect(await f.store.bootstrap(browser, 100)).toBe(true)
    expect(await f.store.bootstrap({ ...browser, browserSetId: 'extra', handleHash: 'extra' }, 100)).toBe(false)
    await f.create()
    expect(f.rows('retained_pending').map(p => p.expires_at)).toEqual([200])
    const before = f.snapshot()
    const input: PendingIncoming = { ...browser, pendingId: 'extra', grantId: 'grant', tokenHash: 'token-hash',
      expected: { browserSetId: 'browser', sessionId: null, version: 1 } }
    expect(await f.store.createPending(input, 101)).toBeNull()
    expect(f.snapshot()).toEqual(before)
    expect(f.rows('retained_browser_sets').map(b => b.expires_at)).toEqual([2592100])
  })

  it('gate pending storage quota counts even expired rows', async () => {
    const f = await ready({ gatePending: 1 })
    f.sqlite.exec('UPDATE retained_pending SET expires_at = 100')
    const before = f.snapshot()
    expect(await f.store.createPending({ ...f.input, pendingId: 'extra' }, 101)).toBeNull()
    expect(f.snapshot()).toEqual(before)
  })

  it('pending selection CAS zero rows forces rollback of inserted proof', async () => {
    const f = fixture()
    f.grant()
    expect(await f.store.bootstrap(browser, 100)).toBe(true)
    f.sqlite.exec('CREATE TRIGGER skip BEFORE UPDATE ON retained_browser_sets BEGIN SELECT RAISE(IGNORE); END')
    const before = f.snapshot()
    await expect(f.store.createPending({ ...browser, pendingId: 'pending', grantId: 'grant', tokenHash: 'token-hash',
      expected: { browserSetId: 'browser', sessionId: null, version: 0 } }, 100)).rejects.toThrow('CHECK constraint failed: ready IN (0, 1)')
    expect(f.snapshot()).toEqual(before)
  })

  it.each([0, -1, -0, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid limits %s', value => {
    const f = fixture()
    expect(() => d1RetainedStore(f.db, { ...limits, sessions: value })).toThrow('Invalid retained integer')
  })
})

// Opt-in: use the demo's already-installed Wrangler dependency, without adding
// package dependencies or making the default suite require a runtime install.
it.runIf(process.env.OA_D1_RUNTIME === '1')('Miniflare/workerd runs the actual D1 batch dependency and rollback pattern', async () => {
  const require = createRequire(realpathSync(fileURLToPath(new URL('../demo/node_modules/wrangler/package.json', import.meta.url).href)))
  const { Miniflare, convertV4MiniflareOptions } = require('miniflare') as {
    convertV4MiniflareOptions(options: Record<string, unknown>): Record<string, unknown>
    Miniflare: new (options: Record<string, unknown>) => {
      getD1Database(name: string): Promise<D1Database>
      dispose(): Promise<void>
    }
  }
  const runtime = new Miniflare(convertV4MiniflareOptions({
    host: '127.0.0.1',
    port: 0,
    inspectorPort: 0,
    modules: true,
    script: 'export default { fetch() { return new Response("local D1 feasibility") } }',
    compatibilityDate: '2026-08-11',
    d1Databases: { DB: 'retained-feasibility' },
  }))
  try {
    const db = await runtime.getD1Database('DB')
    // Let SQLite parse the actual migrations; replay its schema statements on
    // D1 rather than inventing a semicolon/comment-splitting migration parser.
    const local = fixture()
    const schema = local.sqlite.prepare(`SELECT sql FROM sqlite_master
      WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid`).all()
    await db.batch(schema.map(row => db.prepare(String(row.sql))))
    const store = d1RetainedStore(db, limits)
    await db.prepare(`INSERT INTO grants (id, token_hash, scopes, created_at, created_by, max_redeems)
      VALUES ('grant', 'token-hash', 'read', 1, 'admin', 1)`).run()
    expect(await store.bootstrap(browser, 100)).toBe(true)
    const pending: PendingIncoming = { ...browser, pendingId: 'pending', grantId: 'grant', tokenHash: 'token-hash',
      expected: { browserSetId: 'browser', sessionId: null, version: 0 } }
    const context = await store.createPending(pending, 100)
    expect(context).toEqual({ browserSetId: 'browser', sessionId: null, version: 1 })
    const input: CommitIncoming = { ...pending, expected: context!, operationId: 'operation', newSessionId: 'session', select: true }
    const tables = ['grants', 'retained_browser_sets', 'retained_pending', 'retained_sessions', 'retained_operations']
    const snapshot = async () => {
      const results = await db.batch(tables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY id`)))
      return results.map(result => result.results)
    }
    const before = await snapshot()
    for (const [event, table, when] of [
      ['UPDATE', 'retained_pending', ''],
      ['UPDATE', 'grants', ''],
      ['INSERT', 'retained_sessions', ''],
      ['UPDATE', 'retained_browser_sets', ''],
      ['UPDATE', 'retained_operations', 'WHEN NEW.stage = 5'],
    ]) {
      await db.prepare(`CREATE TRIGGER skip BEFORE ${event} ON ${table} ${when} BEGIN SELECT RAISE(IGNORE); END`).run()
      await expect(store.commitIncoming(input, 101)).rejects.toThrow(/CHECK constraint failed/)
      expect(await snapshot()).toEqual(before)
      await db.prepare('DROP TRIGGER skip').run()
    }
    expect(await Promise.all([store.commitIncoming(input, 101), store.commitIncoming(input, 101)])).toEqual([
      { sessionId: 'session', committedVersion: 2 }, { sessionId: 'session', committedVersion: 2 },
    ])
    await db.prepare('UPDATE retained_browser_sets SET active_session_id = NULL, selection_version = 3').run()
    const committed = await snapshot()
    expect(await store.commitIncoming(input, 102)).toEqual({ sessionId: 'session', committedVersion: 2 })
    expect(await store.commitIncoming({ ...input, select: false }, 102)).toBeNull()
    expect(await snapshot()).toEqual(committed)
    const counts = await db.prepare('SELECT redeems FROM grants').all()
    expect(counts.results).toEqual([{ redeems: 1 }])
  } finally {
    await runtime.dispose()
  }
}, 30000)
