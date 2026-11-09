import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { d1GrantStore, d1PendingAuthStore } from '../src/adapters/d1.js'
import { d1RetainedStore } from '../src/adapters/d1-retained.js'
import { emailCodeAuth } from '../src/core/email-codes.js'
import type { EmailMessage } from '../src/core/email.js'
import { createGate } from '../src/core/gate.js'
import type { CommitEmail, RetainedLimits } from '../src/core/retained-store.js'
import { SELECTION_CONTEXT_HEADER } from '../src/core/selection-context.js'
import { hashToken } from '../src/core/tokens.js'
import { testDbRaw } from './d1-shim.js'

const NOW = 1_000_000
const EMAIL = 'ann@example.test'
const LIMITS: RetainedLimits = {
  sessions: 1, pending: 2, gateBrowserSets: 10, gatePending: 20,
  browserTtlS: 3000, pendingTtlS: 600, retryTtlS: 900, defaultSessionTtlS: 3600,
}
const close: (() => void)[] = []
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW * 1000)
})
afterEach(() => {
  vi.useRealTimers()
  for (const fn of close.splice(0)) fn()
})

function fixture() {
  const { raw } = testDbRaw(['retained-login'])
  close.push(() => raw.close())
  // Execute every batch synchronously, including reads, so concurrent promises
  // cannot interleave inside SQLite's transaction (matching D1's boundary).
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
  const retained = d1RetainedStore(db, LIMITS)
  const pending = d1PendingAuthStore(db)
  const denied = new Set<string>()
  const gate = createGate({
    store: d1GrantStore(db), secret: 'local-test-secret-no-production-value',
    policy: async email => denied.has(email) ? null : ['read'], retained: { store: retained },
  })
  const sent: EmailMessage[] = []
  const flow = emailCodeAuth({
    gate, store: pending, from: 'test@example.test', nowMs: () => NOW * 1000,
    linkFor: token => `https://app.test/link?token=${token}`,
    send: async message => { sent.push(message); return { ok: true } },
  })
  const request = (cookie: string, body?: unknown) => new Request('https://app.test/email', {
    method: 'POST', headers: { cookie }, body: JSON.stringify(body),
  })
  const snapshot = () => Object.fromEntries([
    'pending_auth', 'retained_browser_sets', 'retained_sessions', 'retained_operations', 'grants',
  ].map(table => [table, raw.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]))
  const start = async (cookie = '') => {
    const response = await flow.start({ request: request(cookie, { email: EMAIL }) })
    const { id } = await response.json() as { id: string }
    const text = sent.at(-1)!.text
    return { id, code: /\b(\d{6})\b/.exec(text)![1]!, token: /token=([\w-]+)/.exec(text)![1]! }
  }
  return { db, raw, retained, pending, gate, sent, flow, request, snapshot, denied, start,
    fail: (index: number) => { failAt = index } }
}

describe('retained email completion', () => {
  it('a full browser does not burn the emailed proof, so removing a login permits retry', async () => {
    const f = fixture()
    const signedIn = await f.gate.signIn('bob@example.test', f.request(''), NOW * 1000)
    const cookie = signedIn!.cookies[0]!.split(';')[0]!
    const started = await f.flow.start({ request: f.request(cookie, { email: EMAIL }) })
    const { id } = await started.json() as { id: string }
    const code = /\b(\d{6})\b/.exec(f.sent[0]!.text)![1]!
    const before = await f.pending.byId(id)
    const response = await f.flow.verifyCode({ request: f.request(cookie, { id, code }) })
    expect([response.status, await response.json()]).toEqual([
      409, { ok: false, error: 'retained-login-capacity' },
    ])
    expect(await f.pending.byId(id)).toEqual(before)
    const selection = await f.gate.retained!.selection(f.request(cookie), NOW * 1000)
    const accounts = await f.gate.retained!.accounts(f.request(cookie), NOW * 1000)
    const remove = new Request('https://app.test/remove', {
      headers: { cookie, [SELECTION_CONTEXT_HEADER]: selection! },
    })
    await f.gate.retained!.remove(remove, accounts!.active!, NOW * 1000)
    const retried = await f.flow.verifyCode({ request: f.request(cookie, { id, code }) })
    expect([retried.status, await retried.json(), (await f.pending.byId(id))!.consumedAt]).toEqual([
      200, { ok: true }, NOW,
    ])
    expect((await f.gate.retained!.accounts(f.request(cookie), NOW * 1000))!.accounts.map(a => [a.email, a.active])).toEqual([
      [EMAIL, true],
    ])
  })

  it('a policy refusal preserves proof and creates no retained state; allowing again permits retry', async () => {
    const f = fixture()
    const { id, code } = await f.start()
    const before = f.snapshot()
    f.denied.add(EMAIL)
    const response = await f.flow.verifyCode({ request: f.request('', { id, code }) })
    expect([response.status, await response.json()]).toEqual([403, { ok: false }])
    expect(f.snapshot()).toEqual(before)
    f.denied.clear()
    const retried = await f.flow.verifyCode({ request: f.request('', { id, code }) })
    expect([retried.status, await retried.json()]).toEqual([200, { ok: true }])
  })

  it('concurrent link and code requests have exactly one success, one session, and one consumption', async () => {
    const f = fixture()
    const { id, code, token } = await f.start()
    const responses = await Promise.all([
      f.flow.verifyCode({ request: f.request('', { id, code }) }),
      f.flow.verifyLink({ request: new Request(`https://app.test/link?token=${token}`) }),
    ])
    expect(responses.map(r => (r.headers as unknown as { getSetCookie(): string[] }).getSetCookie().length).sort()).toEqual([0, 1])
    expect((await f.pending.byId(id))!.consumedAt).toBe(NOW)
    expect(f.raw.prepare('SELECT sub, issued_at, expires_at, revoked_at FROM retained_sessions').all()).toEqual([
      { sub: `e:${EMAIL}`, issued_at: NOW, expires_at: NOW + 2592000, revoked_at: null },
    ])
    const before = f.snapshot()
    const reused = await f.flow.verifyCode({ request: f.request('', { id, code }) })
    expect([reused.status, await reused.json()]).toEqual([400, { ok: false }])
    expect(f.snapshot()).toEqual(before)
  })

  it('an invalid proof at commit maps to the usual code failure, not capacity', async () => {
    const f = fixture()
    const { id, code } = await f.start()
    const original = f.retained.commitEmail.bind(f.retained)
    vi.spyOn(f.retained, 'commitEmail').mockImplementation((input, now) => {
      f.raw.prepare('UPDATE pending_auth SET attempts = 5 WHERE id = ?').run(id)
      return original(input, now)
    })
    const response = await f.flow.verifyCode({ request: f.request('', { id, code }) })
    expect([response.status, await response.json(), (await f.pending.byId(id))!.consumedAt]).toEqual([
      400, { ok: false }, null,
    ])
    expect(f.raw.prepare('SELECT * FROM retained_sessions').all()).toEqual([])
  })
})

async function ready() {
  const f = fixture()
  const binding = { gateId: 'gate', browserSetId: 'browser', handleHash: 'keyed-test-handle' }
  expect(await f.retained.bootstrap(binding, NOW)).toBe(true)
  const input: CommitEmail = {
    ...binding, expected: { browserSetId: 'browser', sessionId: null, version: 0 },
    sessionId: 'session', issuedAt: NOW, expiresAt: NOW + 1000, select: true,
    proof: { pendingId: 'proof', email: EMAIL, kind: 'code', hash: await hashToken(`${EMAIL}:123456`), maxAttempts: 5 },
  }
  await f.pending.insert({
    id: 'proof', email: EMAIL, tokenHash: await hashToken('test-link'), codeHash: input.proof.hash,
    createdAt: NOW, expiresAt: NOW + 600, consumedAt: null, attempts: 0, ipHash: null,
  })
  return { ...f, input }
}

describe('D1 atomic email-proof guards', () => {
  it('consumes, creates the email principal and selects in one transaction; reuse changes nothing', async () => {
    const f = await ready()
    expect(await f.retained.commitEmail(f.input, NOW)).toEqual({
      ok: true, selection: { browserSetId: 'browser', sessionId: 'session', version: 1 },
    })
    expect(f.raw.prepare('SELECT * FROM retained_sessions').all()).toEqual([
      { id: 'session', browser_set_id: 'browser', grant_id: null, sub: `e:${EMAIL}`,
        issued_at: NOW, expires_at: NOW + 1000, revoked_at: null },
    ])
    const before = f.snapshot()
    expect(await f.retained.commitEmail(f.input, NOW)).toEqual({ ok: false, error: 'email-proof-invalid' })
    expect(f.snapshot()).toEqual(before)
  })

  it.each([
    ['wrong code hash', 'UPDATE pending_auth SET code_hash = \'different\''],
    ['wrong email', 'UPDATE pending_auth SET email = \'other@example.test\''],
    ['expired proof', `UPDATE pending_auth SET expires_at = ${NOW}`],
    ['consumed proof', `UPDATE pending_auth SET consumed_at = ${NOW}`],
    ['exhausted code', 'UPDATE pending_auth SET attempts = 5'],
    ['deleted proof', 'DELETE FROM pending_auth'],
  ])('%s refuses without writes', async (_label, change) => {
    const f = await ready()
    f.raw.exec(change)
    const before = f.snapshot()
    expect(await f.retained.commitEmail(f.input, NOW)).toEqual({ ok: false, error: 'email-proof-invalid' })
    expect(f.snapshot()).toEqual(before)
  })

  it.each([
    ['wrong gate', { gateId: 'other' }],
    ['wrong handle', { handleHash: 'other' }],
    ['wrong browser', { browserSetId: 'other', expected: { browserSetId: 'other', sessionId: null, version: 0 } }],
    ['stale version', { expected: { browserSetId: 'browser', sessionId: null, version: 1 } }],
    ['wrong selection', { expected: { browserSetId: 'browser', sessionId: 'other', version: 0 } }],
  ])('%s leaves a valid proof retryable', async (_label, change) => {
    const f = await ready()
    const before = f.snapshot()
    expect(await f.retained.commitEmail({ ...f.input, ...change }, NOW)).toEqual({ ok: false, error: 'selection_context_conflict' })
    expect(f.snapshot()).toEqual(before)
  })

  it('rechecks link hash and expiry but permits a valid link after the code guess cap', async () => {
    const f = await ready()
    const proof = { pendingId: 'proof', email: EMAIL, kind: 'link' as const, hash: await hashToken('test-link') }
    f.raw.exec('UPDATE pending_auth SET attempts = 5')
    const before = f.snapshot()
    expect(await f.retained.commitEmail({ ...f.input, proof: { ...proof, hash: 'wrong' } }, NOW)).toEqual({ ok: false, error: 'email-proof-invalid' })
    expect(await f.retained.commitEmail({ ...f.input, proof }, NOW + 600)).toEqual({ ok: false, error: 'email-proof-invalid' })
    expect(f.snapshot()).toEqual(before)
    expect(await f.retained.commitEmail({ ...f.input, proof }, NOW)).toEqual({
      ok: true, selection: { browserSetId: 'browser', sessionId: 'session', version: 1 },
    })
  })

  it('two browser sets racing code/link have one winner and no writes in the losing batch', async () => {
    const f = await ready()
    const other = { gateId: 'gate', browserSetId: 'other', handleHash: 'other-handle' }
    await f.retained.bootstrap(other, NOW)
    expect(await Promise.all([
      f.retained.commitEmail(f.input, NOW),
      f.retained.commitEmail({
        ...f.input, ...other, expected: { browserSetId: 'other', sessionId: null, version: 0 }, sessionId: 'second',
        proof: { ...f.input.proof, kind: 'link', hash: await hashToken('test-link') },
      }, NOW),
    ])).toEqual([
      { ok: true, selection: { browserSetId: 'browser', sessionId: 'session', version: 1 } },
      { ok: false, error: 'email-proof-invalid' },
    ])
    expect(f.raw.prepare('SELECT id, active_session_id, selection_version FROM retained_browser_sets ORDER BY id').all()).toEqual([
      { id: 'browser', active_session_id: 'session', selection_version: 1 },
      { id: 'other', active_session_id: null, selection_version: 0 },
    ])
    expect(f.raw.prepare('SELECT id FROM retained_sessions').all()).toEqual([{ id: 'session' }])
  })

  it('replaces the same email at capacity without renewing other evidence', async () => {
    const f = await ready()
    const expected = await f.retained.addSession({
      ...f.input, sub: `e:${EMAIL}`, sessionId: 'old', expiresAt: NOW + 100,
    }, NOW)
    expect(await f.retained.commitEmail({ ...f.input, expected: expected!, select: false }, NOW)).toEqual({
      ok: true, selection: { browserSetId: 'browser', sessionId: 'session', version: 2 },
    })
    expect(f.raw.prepare('SELECT id, expires_at, revoked_at FROM retained_sessions ORDER BY id').all()).toEqual([
      { id: 'old', expires_at: NOW + 100, revoked_at: NOW },
      { id: 'session', expires_at: NOW + 1000, revoked_at: null },
    ])
  })

  it('a skipped replacement revocation rolls back proof, new login and selection', async () => {
    const f = await ready()
    const expected = await f.retained.addSession({ ...f.input, sub: `e:${EMAIL}`, sessionId: 'old' }, NOW)
    f.raw.exec(`CREATE TRIGGER skip BEFORE UPDATE ON retained_sessions
      WHEN NEW.revoked_at IS NOT NULL BEGIN SELECT RAISE(IGNORE); END`)
    const before = f.snapshot()
    await expect(f.retained.commitEmail({ ...f.input, expected: expected! }, NOW)).rejects.toThrow('CHECK constraint failed: stage BETWEEN 0 AND 5')
    expect(f.snapshot()).toEqual(before)
  })

  it('a colliding session selector rolls back proof instead of reusing another login', async () => {
    const f = await ready()
    f.raw.exec(`INSERT INTO retained_sessions VALUES ('session', 'browser', NULL, ${NOW - 100}, ${NOW}, NULL, 'e:other@example.test')`)
    const before = f.snapshot()
    await expect(f.retained.commitEmail(f.input, NOW)).rejects.toThrow('UNIQUE constraint failed: retained_sessions.id')
    expect(f.snapshot()).toEqual(before)
  })

  it.each([
    ['proof consumption', 'UPDATE', 'pending_auth', ''],
    ['session insertion', 'INSERT', 'retained_sessions', ''],
    ['selection update', 'UPDATE', 'retained_browser_sets', ''],
    ['completion result', 'UPDATE', 'retained_operations', 'WHEN NEW.stage = 5'],
  ])('zero-row %s rolls back proof and every retained write', async (_label, event, table, when) => {
    const f = await ready()
    f.raw.exec(`CREATE TRIGGER skip BEFORE ${event} ON ${table} ${when} BEGIN SELECT RAISE(IGNORE); END`)
    const before = f.snapshot()
    await expect(f.retained.commitEmail(f.input, NOW)).rejects.toThrow('CHECK constraint failed: stage BETWEEN 0 AND 5')
    expect(f.snapshot()).toEqual(before)
  })

  it.each(Array.from({ length: 12 }, (_, index) => index))('storage fault at statement %i rolls back the entire completion', async index => {
    const f = await ready()
    const before = f.snapshot()
    f.fail(index)
    await expect(f.retained.commitEmail(f.input, NOW)).rejects.toThrow(`Injected batch failure at ${index}`)
    expect(f.snapshot()).toEqual(before)
  })
})

it.runIf(process.env.OA_D1_RUNTIME === '1')('local workerd D1 proves email completion guards and rollback', async () => {
  vi.useRealTimers()
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
    script: 'export default { fetch() { return new Response("local email proof test") } }',
    compatibilityDate: '2026-08-11', d1Databases: { DB: 'retained-email-proof-test' },
  }))
  try {
    const f = await ready()
    const db = await runtime.getD1Database('DB')
    const schema = f.raw.prepare(`SELECT sql FROM sqlite_master
      WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid`).all()
    await db.batch(schema.map(row => db.prepare(String(row.sql))))
    const retained = d1RetainedStore(db, LIMITS)
    const pending = d1PendingAuthStore(db)
    await retained.bootstrap(f.input, NOW)
    await pending.insert((await f.pending.byId('proof'))!)
    const before = await pending.byId('proof')
    await db.prepare(`CREATE TRIGGER skip BEFORE UPDATE ON retained_browser_sets BEGIN SELECT RAISE(IGNORE); END`).run()
    await expect(retained.commitEmail(f.input, NOW)).rejects.toThrow('CHECK constraint failed: stage BETWEEN 0 AND 5')
    expect(await pending.byId('proof')).toEqual(before)
    expect((await db.prepare('SELECT id FROM retained_sessions').all()).results).toEqual([])
    await db.prepare('DROP TRIGGER skip').run()
    expect(await retained.commitEmail({ ...f.input, proof: { ...f.input.proof, hash: 'wrong' } }, NOW)).toEqual({
      ok: false, error: 'email-proof-invalid',
    })
    expect(await retained.commitEmail(f.input, NOW)).toEqual({
      ok: true, selection: { browserSetId: 'browser', sessionId: 'session', version: 1 },
    })
    expect(await retained.commitEmail(f.input, NOW)).toEqual({ ok: false, error: 'email-proof-invalid' })
  } finally {
    await runtime.dispose()
  }
}, 60_000)
