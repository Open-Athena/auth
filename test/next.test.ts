import { describe, expect, it } from 'vitest'
import { safeNext } from '../src/core/next.js'

describe('safeNext', () => {
  it.each([
    ['/', '/'],
    ['/reports', '/reports'],
    ['/reports?a=1&b=2#top', '/reports?a=1&b=2#top'],
    ['/signin/return?next=%2Foidc%2Fauthorize%3Fx%3D1', '/signin/return?next=%2Foidc%2Fauthorize%3Fx%3D1'],
    ['/a/../b', '/b'],
    ['/a\\b', '/a/b'],
    ['/a\r\nset-cookie:x', '/aset-cookie:x'],
  ])('keeps the same-origin path %j as %j', (raw, expected) => {
    expect(safeNext(raw, '/home')).toBe(expected)
  })

  it.each([
    'https://evil.test/',
    'evil.test',
    '//evil.test',
    '/\\evil.test',
    '\\\\evil.test',
    '/\t/evil.test',
    '/\n/evil.test',
    '/\\\t\\evil.test',
    '/x/..//evil.test',
    '/.//evil.test',
    '',
  ])('falls back on %j', raw => {
    expect(safeNext(raw, '/home')).toBe('/home')
  })

  it('falls back on nothing at all, and can fall back to null', () => {
    expect([safeNext(null, '/home'), safeNext(undefined, '/home'), safeNext('//evil.test', null)]).toEqual(['/home', '/home', null])
  })
})
