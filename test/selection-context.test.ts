import { describe, expect, it } from 'vitest'
import {
  checkSelectionContext,
  MAX_SELECTION_CONTEXT_LENGTH,
  nextSelectionVersion,
  parseSelectionContext,
  SELECTION_CONTEXT_HEADER,
  serializeSelectionContext,
  type SelectionContext,
} from '../src/core/selection-context.js'

const current: SelectionContext = { browserSetId: 'browser-1', sessionId: 'session-A', version: 4 }
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')

describe('selection context', () => {
  it('serializes a canonical header and round-trips safe metadata only', () => {
    expect(SELECTION_CONTEXT_HEADER).toBe('X-OA-Selection-Context')
    const header = serializeSelectionContext(current)
    expect(header).toBe(encode({ browserSetId: 'browser-1', sessionId: 'session-A', version: 4 }))
    expect(parseSelectionContext(header)).toEqual(current)
    expect(serializeSelectionContext({ version: 4, sessionId: 'session-A', browserSetId: 'browser-1' })).toBe(header)
    expect(serializeSelectionContext({ ...current, actor: 'forged' } as SelectionContext)).toBe(header)
    expect(parseSelectionContext(encode({ ...current, actor: 'forged' }))).toBe(null)
  })

  it.each([null, 'session-A', 'unicode-\u00e9'])('accepts exact selection %s without granting authority', sessionId => {
    const context = { ...current, sessionId }
    expect(parseSelectionContext(serializeSelectionContext(context))).toEqual(context)
    expect(checkSelectionContext(serializeSelectionContext(context), context)).toBe(null)
  })

  it.each([
    null, '', '!', 'e30=', 'e30', 'x'.repeat(MAX_SELECTION_CONTEXT_LENGTH + 1),
    encode(null), encode([]), encode({}),
    encode({ ...current, version: -1 }), encode({ ...current, version: 0.5 }),
    encode({ ...current, version: Number.MAX_SAFE_INTEGER + 1 }),
    encode({ ...current, version: '4' }), encode({ ...current, sessionId: 1 }),
    encode({ ...current, browserSetId: '' }), encode({ ...current, sessionId: '' }),
    encode({ ...current, browserSetId: 'x'.repeat(257) }),
    encode({ ...current, sessionId: 'x'.repeat(257) }),
    encode({ version: 4, sessionId: 'session-A', browserSetId: 'browser-1' }),
    Buffer.from('{"browserSetId":"browser-1","sessionId":"session-A","version":4,"version":4}').toString('base64url'),
  ])('rejects absent or malformed headers: %s', async header => {
    expect(parseSelectionContext(header)).toBe(null)
    const response = checkSelectionContext(header, current)!
    expect(response.status).toBe(409)
    expect(Object.fromEntries(response.headers)).toEqual({
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
    })
    expect(await response.text()).toBe('{"error":"selection_context_conflict","recoverable":true,"action":"refresh_selection"}\n')
  })

  it.each([
    { ...current, version: 3 },
    { ...current, version: 5 },
    { ...current, sessionId: 'session-B' },
    { ...current, sessionId: null },
    { ...current, browserSetId: 'other-browser-or-gate' },
  ])('rejects stale, future, signed-out, and cross-browser/gate assertions', async intended => {
    const response = checkSelectionContext(serializeSelectionContext(intended), current)!
    expect(response.status).toBe(409)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ error: 'selection_context_conflict', recoverable: true, action: 'refresh_selection' })
  })

  it('detects A -> B -> A and sign-out without resetting versions', () => {
    const before = serializeSelectionContext(current)
    const switched = { ...current, sessionId: 'session-B', version: nextSelectionVersion(current.version) }
    const returned = { ...current, version: nextSelectionVersion(switched.version) }
    const signedOut = { ...returned, sessionId: null, version: nextSelectionVersion(returned.version) }
    expect([switched.version, returned.version, signedOut.version]).toEqual([5, 6, 7])
    expect(checkSelectionContext(before, returned)!.status).toBe(409)
    expect(checkSelectionContext(before, signedOut)!.status).toBe(409)
  })

  it.each([-1, -0, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('throws for invalid trusted version %s', version => {
    expect(() => serializeSelectionContext({ ...current, version })).toThrow('Invalid selection context')
    expect(() => checkSelectionContext(null, { ...current, version })).toThrow('Invalid selection context')
    expect(() => nextSelectionVersion(version)).toThrow('Invalid selection version')
  })

  it('supports safe integer boundaries and refuses overflow', () => {
    for (const version of [0, Number.MAX_SAFE_INTEGER]) {
      const context = { ...current, version }
      expect(parseSelectionContext(serializeSelectionContext(context))).toEqual(context)
    }
    expect(nextSelectionVersion(0)).toBe(1)
    expect(nextSelectionVersion(Number.MAX_SAFE_INTEGER - 1)).toBe(Number.MAX_SAFE_INTEGER)
    expect(() => nextSelectionVersion(Number.MAX_SAFE_INTEGER)).toThrow('Selection version exhausted')
  })
})
