import { describe, expect, it } from 'vitest'
import { b64uDecodeBytes, b64uDecodeString, b64uEncode } from '../src/core/base64.js'
import { generateId, generateToken, hashIp, hashToken } from '../src/core/tokens.js'

describe('base64url', () => {
  it('round-trips bytes and strips padding', () => {
    const bytes = Uint8Array.from([0xff, 0xfe, 0xfd, 0x00, 0x3e, 0x3f])
    expect(b64uEncode(bytes)).toBe('__79AD4_')
    expect([...b64uDecodeBytes('__79AD4_')]).toEqual([...bytes])
  })

  it('round-trips utf-8 text', () => {
    const s = '{"sub":"e:å@ø.test"}'
    expect(b64uDecodeString(b64uEncode(new TextEncoder().encode(s)))).toBe(s)
  })

  it('handles inputs past the argument-spread limit', () => {
    const big = new Uint8Array(200_000).fill(7)
    expect(b64uDecodeBytes(b64uEncode(big)).length).toBe(big.length)
  })
})

describe('tokens', () => {
  it('mints 24-byte url-safe tokens and 9-byte ids', () => {
    expect(generateToken()).toMatch(/^[A-Za-z0-9_-]{32}$/)
    expect(generateId()).toMatch(/^[A-Za-z0-9_-]{12}$/)
  })

  it('does not repeat', () => {
    const tokens = Array.from({ length: 100 }, generateToken)
    expect(new Set(tokens).size).toBe(100)
  })

  it('hashes stably to 43 url-safe chars, and distinctly per token', async () => {
    const t = generateToken()
    const [a, b, other] = await Promise.all([hashToken(t), hashToken(t), hashToken(generateToken())])
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(b).toBe(a)
    expect(other).not.toBe(a)
  })

  it('hashes a known token to a known digest', async () => {
    expect(await hashToken('open-athena')).toBe(
      b64uEncode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('open-athena')))),
    )
  })
})

describe('hashIp', () => {
  it('is keyed: same ip differs across secrets, and is stable within one', async () => {
    const [a, aAgain, b, otherIp] = await Promise.all([
      hashIp('203.0.113.7', 's1'),
      hashIp('203.0.113.7', 's1'),
      hashIp('203.0.113.7', 's2'),
      hashIp('203.0.113.8', 's1'),
    ])
    expect(aAgain).toBe(a)
    expect(b).not.toBe(a)
    expect(otherIp).not.toBe(a)
  })
})
