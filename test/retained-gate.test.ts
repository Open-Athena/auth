// A gate in retained mode, end to end through its routes: several logins in
// one browser, switching without signing in again, an incoming share link
// that doesn't demote a member, the selection-context guard, sign-out of one
// login versus all, and the import of a pre-retention cookie. Over the real D1
// schema (migrations 0001–0004).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { d1GrantStore } from '../src/adapters/d1.js'
import { d1RetainedStore } from '../src/adapters/d1-retained.js'
import { createGate } from '../src/core/gate.js'
import type { AccountsResponse } from '../src/core/http.js'
import { anyEmailPolicy } from '../src/core/policy.js'
import type { RetainedLimits } from '../src/core/retained-store.js'
import type { IncomingPolicy } from '../src/core/retained.js'
import { authRoutes } from '../src/core/routes.js'
import { SELECTION_CONTEXT_HEADER } from '../src/core/selection-context.js'
import { testDbRaw } from './d1-shim.js'

const SECRET = 'test-secret-0123456789abcdef'
const NOW = Date.parse('2026-10-24T12:00:00Z')
const HOST = 'https://app.test'
const LIMITS: RetainedLimits = {
  sessions: 3, pending: 2, gateBrowserSets: 50, gatePending: 50,
  browserTtlS: 30 * 86400, pendingTtlS: 600, retryTtlS: 86400, defaultSessionTtlS: 3600,
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})
afterEach(() => {
  vi.useRealTimers()
})

/** A browser: a cookie jar that follows `Set-Cookie`, and the selection it last saw. */
class Browser {
  jar = new Map<string, string>()
  selection: string | null = null
  header(): string {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ')
  }
  take(res: Response) {
    // Node's `Headers` has `getSetCookie`; the Workers types this file compiles against don't declare it.
    for (const c of (res.headers as unknown as { getSetCookie(): string[] }).getSetCookie()) {
      const [pair, ...attrs] = c.split(';')
      const [name, ...v] = pair!.split('=')
      const value = v.join('=')
      if (attrs.some(a => a.trim() === 'Max-Age=0') || value === '') this.jar.delete(name!.trim())
      else this.jar.set(name!.trim(), value)
    }
  }
}

function setup(o: { limits?: Partial<RetainedLimits>; incoming?: IncomingPolicy; delisted?: string[] } = {}) {
  const { db, raw } = testDbRaw()
  const delisted = new Set(o.delisted ?? [])
  const gate = createGate({
    store: d1GrantStore(db),
    secret: SECRET,
    adminEmails: ['boss@x.test'],
    policy: async (e: string) => (delisted.has(e) ? null : ['view']),
    retained: { store: d1RetainedStore(db, { ...LIMITS, ...o.limits }), incoming: o.incoming },
  })
  const handle = authRoutes(gate)
  const call = async (b: Browser, method: string, path: string, data?: unknown, extra: Record<string, string> = {}) => {
    const headers: Record<string, string> = { cookie: b.header(), ...extra }
    if (data !== undefined) headers['content-type'] = 'application/json'
    const res = (await handle(new Request(`${HOST}/api/auth${path}`, { method, headers, body: data === undefined ? undefined : JSON.stringify(data) })))!
    b.take(res)
    const text = await res.text()
    const body = text ? JSON.parse(text) : null
    if (body?.selection) b.selection = body.selection
    return { status: res.status, body }
  }
  /** A mutation carrying the selection the browser last saw. */
  const mutate = (b: Browser, path: string, data?: unknown) =>
    call(b, 'POST', path, data ?? {}, b.selection ? { [SELECTION_CONTEXT_HEADER]: b.selection } : {})
  const signIn = async (b: Browser, email: string) => {
    const res = await gate.signIn(email, new Request(`${HOST}/cb`, { headers: { cookie: b.header() } }))
    for (const c of res!.cookies) b.take(new Response(null, { headers: [['set-cookie', c]] }))
    return res
  }
  const mint = async (name: string, o: { maxRedeems?: number } = {}) =>
    gate.mint({ name, subject: { name }, scopes: ['view'], createdBy: 'boss@x.test', maxRedeems: o.maxRedeems ?? null })
  const whoami = async (b: Browser) => {
    const r = await call(b, 'GET', '/whoami')
    return r.status === 200 ? (r.body.kind === 'sso' ? r.body.email : `link:${r.body.name}`) : [r.status, r.body.reason]
  }
  const accounts = async (b: Browser) => {
    const r = await call(b, 'GET', '/accounts')
    const a = r.body as AccountsResponse
    return a.accounts.map(x => `${x.active ? '*' : ''}${x.kind === 'sso' ? x.email : `link:${x.name}`}`)
  }
  const idOf = async (b: Browser, label: string) => {
    const a = (await call(b, 'GET', '/accounts')).body as AccountsResponse
    return a.accounts.find(x => (x.kind === 'sso' ? x.email : `link:${x.name}`) === label)!.id
  }
  const redeems = (id: string) => (raw.prepare('SELECT redeems FROM grants WHERE id = ?').get(id) as { redeems: number }).redeems
  return { db, raw, gate, handle, call, mutate, signIn, mint, whoami, accounts, idOf, redeems, delisted }
}

describe('retained logins', () => {
  it('signs in as A, adds B, and switches A → B → A without signing in again', async () => {
    const t = setup()
    const b = new Browser()
    await t.signIn(b, 'ann@x.test')
    await t.signIn(b, 'bob@y.test')
    expect([[...b.jar.keys()], await t.whoami(b), await t.accounts(b)]).toEqual([
      ['oa_auth_rs'],
      'bob@y.test',
      ['ann@x.test', '*bob@y.test'],
    ])
    expect((await t.mutate(b, '/accounts/select', { id: await t.idOf(b, 'ann@x.test') })).status).toBe(200)
    expect([await t.whoami(b), await t.accounts(b)]).toEqual(['ann@x.test', ['*ann@x.test', 'bob@y.test']])
    await t.mutate(b, '/accounts/select', { id: await t.idOf(b, 'bob@y.test') })
    expect(await t.whoami(b)).toBe('bob@y.test')
    // Signing in as an address already held refreshes it rather than adding a second.
    await t.signIn(b, 'ann@x.test')
    expect(await t.accounts(b)).toEqual(['bob@y.test', '*ann@x.test'])
  })

  it('a member opening a share link stays the member; the link is held, spends nothing, and can be chosen', async () => {
    const t = setup()
    const b = new Browser()
    await t.signIn(b, 'ann@x.test')
    const { grant, token } = await t.mint('Guest pass', { maxRedeems: 1 })
    const ex = await t.call(b, 'POST', '/exchange', { token })
    expect([ex.status, ex.body.email, typeof ex.body.incoming, t.redeems(grant.id), await t.whoami(b)]).toEqual([
      200, 'ann@x.test', 'string', 0, 'ann@x.test',
    ])
    const a = (await t.call(b, 'GET', '/accounts')).body as AccountsResponse
    expect(a.incoming.map(i => [i.id === ex.body.incoming, i.name])).toEqual([[true, 'Guest pass']])
    expect((await t.mutate(b, '/accounts/incoming', { id: ex.body.incoming })).status).toBe(200)
    expect([await t.whoami(b), await t.accounts(b), t.redeems(grant.id)]).toEqual([
      'link:Guest pass',
      ['ann@x.test', '*link:Guest pass'],
      1,
    ])
    // The member is still there to switch back to; the link's one redemption is spent once.
    await t.mutate(b, '/accounts/select', { id: await t.idOf(b, 'ann@x.test') })
    expect([await t.whoami(b), t.redeems(grant.id)]).toEqual(['ann@x.test', 1])
  })

  it("with no login, a link signs in once; opening it again reuses that session; a bad link doesn't sign anyone out", async () => {
    const t = setup()
    const b = new Browser()
    const { grant, token } = await t.mint('Board')
    expect((await t.call(b, 'POST', '/exchange', { token })).body.name).toBe('Board')
    expect((await t.call(b, 'POST', '/exchange', { token })).body.name).toBe('Board')
    expect([t.redeems(grant.id), await t.accounts(b)]).toEqual([1, ['*link:Board']])
    const dead = await t.mint('Dead')
    await t.gate.revoke(dead.grant.id)
    expect([
      (await t.call(b, 'POST', '/exchange', { token: dead.token })).body,
      (await t.call(b, 'POST', '/exchange', { token: 'not-a-real-token' })).body,
      await t.whoami(b),
    ]).toEqual([{ error: 'invalid link', reason: 'revoked' }, { error: 'invalid link', reason: 'bad-token' }, 'link:Board'])
  })

  it("`incoming: 'switch'` changes to the link at once, keeping the member to switch back to", async () => {
    const t = setup({ incoming: 'switch' })
    const b = new Browser()
    await t.signIn(b, 'ann@x.test')
    const { token } = await t.mint('Guest')
    expect((await t.call(b, 'POST', '/exchange', { token })).body.name).toBe('Guest')
    expect(await t.accounts(b)).toEqual(['ann@x.test', '*link:Guest'])
  })

  it('a revoked link or a delisted address drops out of the list; the active one failing leaves the browser signed out, never on another login', async () => {
    const t = setup()
    const b = new Browser()
    const { grant, token } = await t.mint('Guest')
    await t.signIn(b, 'ann@x.test')
    const ex = await t.call(b, 'POST', '/exchange', { token })
    await t.mutate(b, '/accounts/incoming', { id: ex.body.incoming })
    await t.gate.revoke(grant.id)
    expect([await t.whoami(b), await t.accounts(b)]).toEqual([[401, 'revoked'], ['ann@x.test']])
    await t.mutate(b, '/accounts/select', { id: await t.idOf(b, 'ann@x.test') })
    expect(await t.whoami(b)).toBe('ann@x.test')
    // Delisted with nothing else usable here: the browser's handle goes too.
    t.delisted.add('ann@x.test')
    expect([await t.whoami(b), [...b.jar.keys()], (await t.call(b, 'GET', '/accounts')).status]).toEqual([[401, 'delisted'], [], 404])
  })

  it("a failed active login clears the private cache, and the browser's handle only when nothing is left to switch to", async () => {
    const t = setup()
    const solo = new Browser()
    const { grant, token } = await t.mint('Only')
    await t.call(solo, 'POST', '/exchange', { token })
    const pair = new Browser()
    await t.signIn(pair, 'ann@x.test')
    const second = await t.mint('Second')
    await t.call(pair, 'POST', '/exchange', { token: second.token })
    await t.mutate(pair, '/accounts/incoming', { id: (await t.call(pair, 'GET', '/accounts')).body.incoming[0].id })
    await t.gate.revoke(grant.id)
    await t.gate.revoke(second.grant.id)
    const probe = async (b: Browser) => {
      const res = (await t.handle(new Request(`${HOST}/api/auth/whoami`, { headers: { cookie: b.header() } })))!
      b.take(res)
      return [res.status, res.headers.get('clear-site-data'), [...b.jar.keys()]]
    }
    expect([await probe(solo), await probe(pair)]).toEqual([
      [401, '"cache"', []],
      [401, '"cache"', ['oa_auth_rs']],
    ])
  })

  it('an explicit Bearer token stays request-scoped beside the browser’s logins', async () => {
    const t = setup()
    const b = new Browser()
    await t.signIn(b, 'ann@x.test')
    const { token } = await t.mint('Script')
    const r = await t.call(b, 'GET', '/whoami', undefined, { authorization: `Bearer ${token}` })
    expect([r.body.name, r.body.selection, await t.whoami(b)]).toEqual(['Script', undefined, 'ann@x.test'])
  })

  it('a stale or missing selection is refused with 409 and changes nothing', async () => {
    const t = setup()
    const b = new Browser()
    await t.signIn(b, 'ann@x.test')
    await t.signIn(b, 'bob@y.test')
    await t.whoami(b)
    const annId = await t.idOf(b, 'ann@x.test')
    const seen = b.selection
    // Another tab switches to ann.
    const other = new Browser()
    other.jar = new Map(b.jar)
    await t.whoami(other)
    await t.mutate(other, '/accounts/select', { id: await t.idOf(other, 'ann@x.test') })
    b.selection = seen
    const conflict = { error: 'selection_context_conflict', recoverable: true, action: 'refresh_selection' }
    expect([
      await t.mutate(b, '/accounts/remove', { id: annId }).then(r => [r.status, r.body]),
      await t.mutate(b, '/logout').then(r => [r.status, r.body]),
      await t.call(b, 'POST', '/accounts/select', { id: annId }).then(r => [r.status, r.body]),
    ]).toEqual([
      [409, conflict],
      [409, conflict],
      [409, conflict],
    ])
    expect(await t.accounts(b)).toEqual(['*ann@x.test', 'bob@y.test'])
    // A sign-out with no header at all (a client from before retained mode)
    // signs out whatever is active now: it can only take access away.
    expect((await t.call(b, 'POST', '/logout', {})).status).toBe(200)
    expect(await t.accounts(b)).toEqual(['bob@y.test'])
  })

  it('sign out removes only the active login and selects nothing; sign out of all clears the browser', async () => {
    const t = setup()
    const b = new Browser()
    await t.signIn(b, 'ann@x.test')
    await t.signIn(b, 'bob@y.test')
    await t.whoami(b)
    expect((await t.mutate(b, '/logout')).status).toBe(200)
    expect([await t.whoami(b), await t.accounts(b)]).toEqual([[401, null], ['ann@x.test']])
    expect((await t.mutate(b, '/logout-all')).status).toBe(200)
    expect([[...b.jar.keys()], await t.whoami(b), (await t.call(b, 'GET', '/accounts')).status]).toEqual([[], [401, null], 404])
  })

  it("another browser's handle sees and selects none of these logins", async () => {
    const t = setup()
    const b = new Browser()
    await t.signIn(b, 'ann@x.test')
    const annId = await t.idOf(b, 'ann@x.test')
    const eve = new Browser()
    await t.signIn(eve, 'eve@z.test')
    await t.whoami(eve)
    expect([(await t.mutate(eve, '/accounts/select', { id: annId })).status, await t.whoami(eve), await t.accounts(eve)]).toEqual([
      404,
      'eve@z.test',
      ['*eve@z.test'],
    ])
  })

  it('imports a pre-retention session cookie once, keeping its issue and expiry, and clears it', async () => {
    const t = setup()
    const single = createGate({ store: d1GrantStore(t.db), secret: SECRET, policy: anyEmailPolicy(['view']) })
    const old = await single.signIn('ann@x.test', new Request(HOST), NOW - 3600_000)
    const b = new Browser()
    b.take(new Response(null, { headers: [['set-cookie', old!.cookie]] }))
    expect(await t.whoami(b)).toBe('ann@x.test')
    await t.signIn(b, 'bob@y.test')
    expect([[...b.jar.keys()], await t.accounts(b)]).toEqual([['oa_auth_rs'], ['ann@x.test', '*bob@y.test']])
    const row = t.raw.prepare("SELECT issued_at, expires_at FROM retained_sessions WHERE sub = 'e:ann@x.test'").get()
    expect(row).toEqual({ issued_at: NOW / 1000 - 3600, expires_at: NOW / 1000 - 3600 + 30 * 86400 })
  })

  it('a full browser refuses another login with 409 and keeps every one it has', async () => {
    const t = setup({ limits: { sessions: 2 } })
    const b = new Browser()
    await t.signIn(b, 'ann@x.test')
    await t.signIn(b, 'bob@y.test')
    await expect(t.signIn(b, 'cat@z.test')).rejects.toThrow('retained-login-capacity')
    const { token } = await t.mint('Guest')
    await t.whoami(b)
    const ex = await t.call(b, 'POST', '/exchange', { token })
    expect(await t.mutate(b, '/accounts/incoming', { id: ex.body.incoming })).toEqual({ status: 409, body: { error: 'incoming-unavailable' } })
    expect(await t.accounts(b)).toEqual(['ann@x.test', '*bob@y.test'])
  })
})
