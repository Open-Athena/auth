import { describe, expect, it } from 'vitest'
import { d1GroupSnapshots } from '../src/adapters/d1-groups.js'
import { createGate } from '../src/core/gate.js'
import { groupPolicy } from '../src/groups/index.js'
import { memoryGrantStore } from '../src/testing/index.js'
import { testDbRaw } from './d1-shim.js'

describe('group snapshots', () => {
  const nowMs = () => 1_700_000_000_000
  const nowS = nowMs() / 1000
  const setup = () => d1GroupSnapshots(testDbRaw(['groups']).db)

  it('merges overlapping groups without overwriting a membership or granting unrelated scopes', async () => {
    const store = setup()
    await store.put({ group: 'Owners@x.test', members: ['BO@x.test', 'bo@x.test'], fetchedAt: nowS })
    await store.put({ group: 'staff@x.test', members: ['bo@x.test', 'al@x.test'], fetchedAt: nowS })
    const policy = groupPolicy(store, { groups: { 'Owners@x.test': ['admin', 'view'], 'staff@x.test': ['view'] }, nowMs })
    expect(await store.get('OWNERS@x.test')).toEqual({ group: 'owners@x.test', members: ['bo@x.test'], fetchedAt: nowS })
    expect(await policy('Bo@x.test')).toEqual(['admin', 'view'])
    expect(await policy('al@x.test')).toEqual(['view'])
    expect(await policy('stranger@x.test')).toBeNull()
  })

  it('denies missing, empty, future and stale snapshots including the exact boundary', async () => {
    for (const offset of [1, -900, -901]) {
      const store = setup()
      await store.put({ group: 'owners@x.test', members: ['bo@x.test'], fetchedAt: nowS + offset })
      expect(await groupPolicy(store, { groups: { 'owners@x.test': ['admin'] }, nowMs })('bo@x.test')).toBeNull()
    }
    const store = setup()
    const policy = groupPolicy(store, { groups: { 'owners@x.test': ['admin'] }, nowMs })
    expect(await policy('bo@x.test')).toBeNull()
    await store.put({ group: 'owners@x.test', members: [], fetchedAt: nowS })
    expect(await policy('bo@x.test')).toBeNull()
  })

  it('expires admin independently of fresh view access, and removes a user on the next sync', async () => {
    const store = setup()
    await store.put({ group: 'owners@x.test', members: ['bo@x.test'], fetchedAt: nowS - 900 })
    await store.put({ group: 'staff@x.test', members: ['bo@x.test'], fetchedAt: nowS - 899 })
    const policy = groupPolicy(store, { groups: { 'owners@x.test': ['admin'], 'staff@x.test': ['view'] }, nowMs })
    expect(await policy('bo@x.test')).toEqual(['view'])
    await store.put({ group: 'staff@x.test', members: [], fetchedAt: nowS })
    expect(await policy('bo@x.test')).toBeNull()
  })

  it('does not let an older or same-time completion replace a newer snapshot', async () => {
    const store = setup()
    await store.put({ group: 'owners@x.test', members: [], fetchedAt: nowS })
    await store.put({ group: 'owners@x.test', members: ['removed@x.test'], fetchedAt: nowS - 1 })
    await store.put({ group: 'owners@x.test', members: ['removed@x.test'], fetchedAt: nowS })
    expect(await store.get('owners@x.test')).toEqual({ group: 'owners@x.test', members: [], fetchedAt: nowS })
  })

  it('rejects non-finite or non-positive freshness limits', () => {
    const store = setup()
    for (const maxAgeS of [0, -1, Infinity, NaN]) {
      expect(() => groupPolicy(store, { groups: {}, maxAgeS })).toThrow('groups: maxAgeS must be positive and finite')
    }
  })

  it('denies an already-issued email session when its group snapshot expires', async () => {
    const store = setup()
    let clock = nowMs()
    await store.put({ group: 'owners@x.test', members: ['bo@x.test'], fetchedAt: nowS })
    const gate = createGate({
      store: memoryGrantStore(), secret: 'test-group-policy-secret',
      policy: groupPolicy(store, { groups: { 'owners@x.test': ['admin'] }, nowMs: () => clock }),
    })
    const signed = await gate.signIn('bo@x.test', new Request('https://x.test/'), clock)
    expect(signed?.auth.kind).toBe('sso')
    if (!signed) throw new Error('expected sign-in')
    const request = new Request('https://x.test/private', { headers: { cookie: signed.cookie.split(';')[0]! } })
    expect((await gate.authenticate(request, clock))?.kind).toBe('sso')
    clock += 900_000
    expect(await gate.authenticate(request, clock)).toBeNull()
  })
})
