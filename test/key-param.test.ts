// `keyParam` names the share-link query parameter everywhere the gate reads it (specs/done/key-param-consistency.md).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { d1AuditSink, d1GrantStore } from '../src/adapters/d1.js'
import { CLEAR_KEY, createGate, type GateOptions } from '../src/core/gate.js'
import { domainPolicy } from '../src/core/policy.js'
import { testDb } from './d1-shim.js'

const SECRET = 'test-secret-0123456789abcdef'
const NOW = Date.parse('2026-11-16T12:00:00Z')
const HOST = 'https://jobs.example'

let db: D1Database
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  db = testDb()
})
afterEach(() => { vi.useRealTimers() })

function setup(keyParam: GateOptions['keyParam']) {
  const gate = createGate({
    store: d1GrantStore(db), audit: d1AuditSink(db), secret: SECRET, adminEmails: ['ryan@oa.test'], policy: domainPolicy(['oa.test'], ['*']), keyParam,
  })
  const page = (path: string, headers: Record<string, string> = {}) => new Request(`${HOST}${path}`, { headers })
  const mint = () => gate.mint({ name: 'Hilary', scopes: ['jd'], maxRedeems: 2, createdBy: 'ryan@oa.test' })
  const step = async (path: string, headers: Record<string, string> = {}) => {
    const res = await gate.handleKeyParam(page(path, headers))
    return res && [res.status, res.headers.get('location'), res.headers.get('set-cookie')?.split('=')[0] ?? null]
  }
  return { gate, page, mint, step }
}

describe('`keyParam`', () => {
  it('a custom name is the only one read: `?k=` redeems, `?key=` is just another query param', async () => {
    const t = setup('k')
    const { token } = await t.mint()
    expect([t.gate.keyParam, t.gate.keyParams, await t.step(`/sre?key=${token}`), await t.step(`/sre?k=${token}&key=x`)]).toEqual([
      'k', ['k'], null, [302, '/sre?key=x', 'oa_auth'],
    ])
  })

  it('a list accepts each (first present wins), strips them all, and names the first for new links', async () => {
    const t = setup(['k', 'key'])
    const { token } = await t.mint()
    expect([
      t.gate.keyParam,
      await t.step(`/sre?key=${token}&tab=1`),
      await t.step(`/sre?key=bad&k=${token}`),
      t.gate.presentedKey(new URL(`${HOST}/x?key=a&k=b`)),
      t.gate.presentedKey(new URL(`${HOST}/x?tab=1`)),
    ]).toEqual(['k', [302, '/sre?tab=1', 'oa_auth'], [302, '/sre', 'oa_auth'], 'b', null])
  })

  it('`authenticate` reads the key under its name: a bad `?k=` is a presented token, `?k=-` is not', async () => {
    const t = setup('k')
    const bad = await t.gate.authenticateResult(t.page('/sre?k=nope'))
    const cleared = await t.gate.authenticateResult(t.page(`/sre?k=${CLEAR_KEY}`))
    const other = await t.gate.authenticateResult(t.page('/sre?key=nope'))
    expect([bad, cleared, other].map(r => [r.auth, r.credential, r.reason])).toEqual([
      [null, 'token', 'invalid'], [null, 'none', null], [null, 'none', null],
    ])
  })

  it("a preview bot on `?k=` gets the link's card, not a session", async () => {
    const t = setup(['k', 'key'])
    const { token } = await t.mint()
    const res = (await t.gate.handleKeyParam(t.page(`/sre?k=${token}`, { 'User-Agent': 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)' })))!
    expect([res.status, res.headers.get('set-cookie'), res.headers.get('content-type')]).toEqual([200, null, 'text/html; charset=utf-8'])
  })
})
