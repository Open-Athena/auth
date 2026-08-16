import { describe, expect, it } from 'vitest'
import { b64uDecodeString, b64uEncode } from '../src/core/base64.js'
import {
  clearCookie,
  emailSub,
  grantSub,
  parseSub,
  readCookie,
  sessionCookie,
  signSession,
  verifySession,
} from '../src/core/session.js'

const SECRET = 'test-secret-0123456789abcdef'
const NOW = Date.parse('2026-08-16T00:00:00Z')
const DAY = 24 * 3600 * 1000

describe('signSession / verifySession', () => {
  it('round-trips a subject', async () => {
    const cookie = await signSession(emailSub('a@openathena.ai'), SECRET, NOW)
    expect(await verifySession(cookie, SECRET, NOW)).toBe('e:a@openathena.ai')
  })

  it('encodes v/sub/exp claims and an HMAC, with exp = now + ttl', async () => {
    const cookie = await signSession('g:abc', SECRET, NOW, 3600)
    const [body, sig] = cookie.split('.')
    expect(JSON.parse(b64uDecodeString(body!))).toEqual({
      v: 1,
      sub: 'g:abc',
      exp: NOW / 1000 + 3600,
    })
    expect(sig).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('rejects a payload swapped under a valid signature', async () => {
    const cookie = await signSession(emailSub('a@openathena.ai'), SECRET, NOW)
    const sig = cookie.split('.')[1]!
    const forged = b64uEncode(new TextEncoder().encode(JSON.stringify({ v: 1, sub: 'e:evil@example.com', exp: 4102444800 })))
    expect(await verifySession(`${forged}.${sig}`, SECRET, NOW)).toBe(null)
  })

  it('rejects a mangled signature', async () => {
    const cookie = await signSession(emailSub('a@openathena.ai'), SECRET, NOW)
    const [body, sig] = cookie.split('.')
    expect(await verifySession(`${body}.AAAA${sig!.slice(4)}`, SECRET, NOW)).toBe(null)
  })

  it('rejects the wrong secret', async () => {
    const cookie = await signSession('g:7', SECRET, NOW)
    expect(await verifySession(cookie, 'other-secret-0123456789abcdef', NOW)).toBe(null)
  })

  it('accepts up to the expiry and rejects past it', async () => {
    const cookie = await signSession('g:7', SECRET, NOW, 3600)
    expect(await verifySession(cookie, SECRET, NOW + 3599_000)).toBe('g:7')
    expect(await verifySession(cookie, SECRET, NOW + 3601_000)).toBe(null)
  })

  it('honours a custom ttl', async () => {
    const cookie = await signSession('g:7', SECRET, NOW, 90 * 24 * 3600)
    expect(await verifySession(cookie, SECRET, NOW + 60 * DAY)).toBe('g:7')
  })

  it('rejects malformed values', async () => {
    const results = await Promise.all(
      ['', 'no-dot-here', '.', 'a.b', `${b64uEncode(new TextEncoder().encode('not json'))}.AAAA`].map(v =>
        verifySession(v, SECRET, NOW),
      ),
    )
    expect(results).toEqual([null, null, null, null, null])
  })
})

describe('subjects', () => {
  it('formats and parses both kinds', () => {
    expect([emailSub('a@b.com'), grantSub('xyz')]).toEqual(['e:a@b.com', 'g:xyz'])
    expect([parseSub('e:a@b.com'), parseSub('g:xyz'), parseSub('x:1'), parseSub('')]).toEqual([
      { kind: 'email', value: 'a@b.com' },
      { kind: 'grant', value: 'xyz' },
      null,
      null,
    ])
  })
})

describe('cookies', () => {
  it('sets HttpOnly/Secure/SameSite=Lax with the session ttl', () => {
    expect(sessionCookie('VALUE', { name: 'oa_auth', ttlS: 3600 })).toBe(
      'oa_auth=VALUE; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=3600',
    )
  })

  it('drops Secure for plain-http dev origins', () => {
    expect(sessionCookie('VALUE', { name: 'oa_auth', ttlS: 3600, secure: false })).toBe(
      'oa_auth=VALUE; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600',
    )
  })

  it('clears with Max-Age=0', () => {
    expect(clearCookie({ name: 'oa_auth' })).toBe('oa_auth=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0')
  })

  it('reads one cookie out of several, tolerating "=" in the value', () => {
    const req = new Request('https://x.test/', { headers: { Cookie: 'a=1; oa_auth=v1.sig==; b=2' } })
    expect([readCookie(req, 'oa_auth'), readCookie(req, 'b'), readCookie(req, 'missing')]).toEqual(['v1.sig==', '2', null])
  })
})
