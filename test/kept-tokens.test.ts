// Retrievable link keys (specs/done/retrievable-link-keys.md): kept sealed, read back only by staff through their own
// logged route, replaced by Rotate, dropped by Revoke, and keepable for an existing link by pasting its current key.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { d1AuditSink, d1GrantStore } from '../src/adapters/d1.js'
import { createGate, type GateOptions } from '../src/core/gate.js'
import { authRoutes } from '../src/core/routes.js'
import { testDb } from './d1-shim.js'

const SECRET = 'test-secret-0123456789abcdef'
const NOW = Date.parse('2026-11-15T00:00:00Z')

let db: D1Database
let handle: ReturnType<typeof authRoutes>
let admin: string

async function setup(more: Partial<GateOptions> = {}) {
  const gate = createGate({ store: d1GrantStore(db), audit: d1AuditSink(db), secret: SECRET, adminEmails: ['boss@openathena.ai'], ...more })
  handle = authRoutes(gate)
  admin = (await gate.signIn('boss@openathena.ai', new Request('https://x.test/'), NOW))!.cookie.split(';')[0]!
}

const call = async (method: string, path: string, data?: unknown, cookie: string | null = admin) => {
  const headers = new Headers(cookie ? { cookie } : {})
  if (data !== undefined) headers.set('content-type', 'application/json')
  const res = (await handle(new Request(`https://x.test/api/auth${path}`, { method, headers, ...(data === undefined ? {} : { body: JSON.stringify(data) }) })))!
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null, text }
}
const mint = async (input: Record<string, unknown> = {}) =>
  (await call('POST', '/grants', { scopes: ['reports'], name: 'For Hilary', ...input })).body as { grant: { id: string; kept: boolean }; token: string }
const reveal = async (id: string) => {
  const r = await call('GET', `/grants/${id}/token`)
  return r.status === 200 ? r.body.token as string : `${r.status} ${r.body.error}`
}
const kept = async (id: string) => ((await call('GET', '/grants')).body.grants as { id: string; kept: boolean }[]).find(g => g.id === id)!.kept
const sealed = async (id: string) => (await db.prepare('SELECT token_enc FROM grants WHERE id = ?').bind(id).first<{ token_enc: string | null }>())!.token_enc
const log = async () => (await db.prepare('SELECT event, grant_id AS grantId, reason FROM access_log ORDER BY id').all()).results

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  db = testDb()
  await setup()
})
afterEach(() => { vi.useRealTimers() })

describe('kept link keys', () => {
  it('are off by default: a key is shown once, and there is nothing to read back', async () => {
    const { grant } = await mint()
    expect([grant.kept, await sealed(grant.id), await reveal(grant.id)]).toEqual([false, null, '404 not kept'])
  })

  it('kept at mint: sealed at rest, read back only through its own logged route, never in the list', async () => {
    const { grant, token } = await mint({ keepToken: true })
    const enc = (await sealed(grant.id))!
    const list = await call('GET', '/grants')
    expect({
      kept: grant.kept,
      sealedShape: /^v1\.[A-Za-z0-9_-]+$/.test(enc),
      sealedHasToken: enc.includes(token),
      listHasToken: list.text.includes(token),
      revealed: await reveal(grant.id),
      anonymous: (await call('GET', `/grants/${grant.id}/token`, undefined, null)).status,
    }).toEqual({ kept: true, sealedShape: true, sealedHasToken: false, listHasToken: false, revealed: token, anonymous: 401 })
    expect(await log()).toEqual([
      { event: 'signin', grantId: null, reason: null },
      { event: 'mint', grantId: grant.id, reason: null },
      { event: 'reveal', grantId: grant.id, reason: null },
    ])
  })

  it('keepTokens makes keeping the default, and a mint can still say no', async () => {
    await setup({ keepTokens: true })
    const [yes, no] = [await mint(), await mint({ keepToken: false })]
    expect([yes.grant.kept, no.grant.kept, await reveal(yes.grant.id), await reveal(no.grant.id)]).toEqual([true, false, yes.token, '404 not kept'])
  })

  it('Rotate replaces the kept key (or drops it when told), and Revoke deletes it', async () => {
    const { grant, token } = await mint({ keepToken: true })
    const rotated = (await call('POST', `/grants/${grant.id}/rotate`, {})).body.token as string
    const afterRotate = [await kept(grant.id), await reveal(grant.id)]
    await call('POST', `/grants/${grant.id}/rotate`, { keepToken: false })
    const afterPlainRotate = [await kept(grant.id), await reveal(grant.id)]
    const other = await mint({ keepToken: true })
    await call('POST', `/grants/${other.grant.id}/revoke`)
    expect({ afterRotate, afterPlainRotate, revoked: [await sealed(other.grant.id), await reveal(other.grant.id)], stale: rotated !== token })
      .toEqual({ afterRotate: [true, rotated], afterPlainRotate: [false, '404 not kept'], revoked: [null, '404 not kept'], stale: true })
  })

  it("an existing link's key can be kept by pasting it (the key or the whole link), but only its current key", async () => {
    const { grant, token } = await mint()
    const wrong = await call('PUT', `/grants/${grant.id}/token`, { token: 'not-the-key' })
    const pasted = await call('PUT', `/grants/${grant.id}/token`, { token: `https://jobs.example/eng?key=${token}` })
    const afterPaste = [await kept(grant.id), await reveal(grant.id)]
    const forgot = await call('DELETE', `/grants/${grant.id}/token`)
    const afterForget = [await kept(grant.id), await reveal(grant.id)]
    // A key from before a rotation is no longer this link's.
    await call('POST', `/grants/${grant.id}/rotate`, {})
    const stale = await call('PUT', `/grants/${grant.id}/token`, { token })
    expect({
      wrong: [wrong.status, wrong.body.error],
      pasted: pasted.status,
      afterPaste,
      forgot: forgot.body,
      afterForget,
      stale: [stale.status, stale.body.error],
    }).toEqual({
      wrong: [400, "that isn't this link's current key"],
      pasted: 200,
      afterPaste: [true, token],
      forgot: { ok: true },
      afterForget: [false, '404 not kept'],
      stale: [400, "that isn't this link's current key"],
    })
    expect((await log()).filter(r => r.event === 'keep')).toEqual([
      { event: 'keep', grantId: grant.id, reason: null },
      { event: 'keep', grantId: grant.id, reason: 'forget' },
    ])
  })

  it("won't open under another secret, or moved onto another link's row", async () => {
    const a = await mint({ keepToken: true })
    const b = await mint({ keepToken: true })
    await db.prepare('UPDATE grants SET token_enc = ? WHERE id = ?').bind(await sealed(a.grant.id), b.grant.id).run()
    const moved = await reveal(b.grant.id)
    await setup({ tokenSecret: 'another-secret-0123456789abcdef' })
    expect([moved, await reveal(a.grant.id)]).toEqual(['404 not kept', '404 not kept'])
  })
})

describe('the memory store keeps keys the same way', () => {
  it('mint, reveal, rotate, revoke', async () => {
    const { memoryGrantStore } = await import('../src/testing/index.js')
    const gate = createGate({ store: memoryGrantStore(), secret: SECRET, keepTokens: true })
    const { grant, token } = await gate.mint({ scopes: ['reports'], createdBy: 'boss@openathena.ai' })
    const first = await gate.revealToken(grant.id)
    const rotated = (await gate.rotate(grant.id))!
    const second = await gate.revealToken(grant.id)
    const stale = await gate.keepToken(grant.id, token)
    await gate.revoke(grant.id)
    expect([grant.kept, first === token, rotated.grant.kept, second === rotated.token, stale, await gate.revealToken(grant.id)])
      .toEqual([true, true, true, true, false, null])
  })
})
