import { describe, expect, it } from 'vitest'
import { d1BackchannelStore } from '../src/adapters/d1-backchannel.js'
import { memoryBackchannelStore, type BackchannelStore, type LogoutEvidence } from '../src/backchannel/index.js'
import { testDbRaw } from './d1-shim.js'

const NOW = 1800000000
const evidence: LogoutEvidence = {
  issuer: 'https://login.test', clientId: 'app-a', sid: 'sid-a', sub: 'opaque-sub',
  jti: 'jti-a', digest: 'digest-a', issuedAt: NOW, expiresAt: NOW + 120,
}
const factories: [string, () => BackchannelStore][] = [
  ['memory', memoryBackchannelStore],
  ['D1 SQLite', () => d1BackchannelStore(testDbRaw(['backchannel']).db)],
]

describe.each(factories)('%s receipt and SID store', (_name, make) => {
  it('accepts unknown SIDs, scopes bindings, and enforces logical expiry without cleanup', async () => {
    const store = make()
    expect(await store.accept(evidence, NOW, NOW + 1000)).toBe('accepted')
    expect(await Promise.all([
      store.isRevoked(evidence, NOW),
      store.isRevoked({ ...evidence, issuer: 'https://other.test' }, NOW),
      store.isRevoked({ ...evidence, clientId: 'app-b' }, NOW),
      store.isRevoked({ ...evidence, sid: 'sid-b' }, NOW),
      store.isRevoked(evidence, NOW + 999),
      store.isRevoked(evidence, NOW + 1000),
    ])).toEqual([true, false, false, false, true, false])
  })

  it('replays are idempotent, do not extend retention, and conflicting JTI cannot mutate a new SID', async () => {
    const store = make()
    expect(await store.accept(evidence, NOW, NOW + 1000)).toBe('accepted')
    expect(await store.accept(evidence, NOW + 1, NOW + 5000)).toBe('duplicate')
    expect(await store.accept({ ...evidence, sid: 'sid-b', digest: 'digest-b' }, NOW + 1, NOW + 5000)).toBe('conflict')
    expect(await Promise.all([store.isRevoked({ ...evidence, sid: 'sid-b' }, NOW), store.isRevoked(evidence, NOW + 1000)])).toEqual([false, false])
  })

  it('rejects conflicting subject without consuming its JTI; matching subject can extend retention', async () => {
    const store = make()
    await store.accept(evidence, NOW, NOW + 1000)
    const next = { ...evidence, jti: 'jti-b', digest: 'digest-b' }
    expect(await store.accept({ ...next, sub: 'other-subject' }, NOW, NOW + 2000)).toBe('conflict')
    expect(await store.isRevoked(evidence, NOW + 1000)).toBe(false)
    expect(await store.accept(next, NOW, NOW + 2000)).toBe('accepted')
    expect(await store.isRevoked(evidence, NOW + 1999)).toBe(true)
  })

  it('can bind an initially absent subject but never switch it to another subject', async () => {
    const store = make()
    expect(await store.accept({ ...evidence, sub: null }, NOW, NOW + 1000)).toBe('accepted')
    expect(await store.accept({ ...evidence, jti: 'bind-sub', digest: 'bind-sub' }, NOW, NOW + 2000)).toBe('accepted')
    expect(await store.accept({ ...evidence, jti: 'switch-sub', digest: 'switch-sub', sub: 'other' }, NOW, NOW + 3000)).toBe('conflict')
  })

  it('partitions receipts by issuer and client and never shortens SID retention', async () => {
    const store = make()
    expect(await store.accept(evidence, NOW, NOW + 1000)).toBe('accepted')
    expect(await store.accept({ ...evidence, clientId: 'app-b', digest: 'client-b' }, NOW, NOW + 1000)).toBe('accepted')
    expect(await store.accept({ ...evidence, issuer: 'https://other.test', digest: 'other-issuer' }, NOW, NOW + 1000)).toBe('accepted')
    expect(await store.accept({ ...evidence, jti: 'shorter', digest: 'shorter' }, NOW, NOW + 500)).toBe('accepted')
    expect(await store.isRevoked(evidence, NOW + 999)).toBe(true)
    await expect(store.isRevoked(evidence, Number.NaN)).rejects.toThrow(/^invalid lookup time$/)
  })

  it('rejects expired evidence and unsafe retention before any mutation', async () => {
    const store = make()
    await expect(store.accept(evidence, NOW + 120, NOW + 1000)).rejects.toThrow(/^invalid logout retention or time$/)
    await expect(store.accept(evidence, NOW, NOW + 119)).rejects.toThrow(/^invalid logout retention or time$/)
    await expect(store.accept({ ...evidence, sid: '' }, NOW, NOW + 1000)).rejects.toThrow(/^invalid logout evidence$/)
    expect(await store.isRevoked(evidence, NOW)).toBe(false)
  })

  it('cleanup is bounded per table and receipts expire independently of tombstones', async () => {
    const store = make()
    await store.accept(evidence, NOW, NOW + 1000)
    await store.accept({ ...evidence, jti: 'jti-b', sid: 'sid-b' }, NOW, NOW + 1000)
    expect([await store.cleanup(NOW + 120, 1), await store.cleanup(NOW + 120, 1), await store.cleanup(NOW + 120, 1)]).toEqual([1, 1, 0])
    expect(await store.isRevoked(evidence, NOW + 120)).toBe(true)
    expect([await store.cleanup(NOW + 1000, 1), await store.cleanup(NOW + 1000, 1), await store.cleanup(NOW + 1000, 1)]).toEqual([1, 1, 0])
    await expect(store.cleanup(NOW, 0)).rejects.toThrow(/^invalid cleanup bounds$/)
  })
})

describe('D1 guarded mutation and transaction rollback', () => {
  it('conflicting receipt and subject guards leave exact SQL snapshots unchanged', async () => {
    const { db, raw } = testDbRaw(['backchannel'])
    const store = d1BackchannelStore(db)
    await store.accept(evidence, NOW, NOW + 1000)
    const snapshot = () => ({
      receipts: raw.prepare('SELECT * FROM backchannel_receipts ORDER BY issuer, client_id, jti').all().map(r => ({ ...r })),
      revoked: raw.prepare('SELECT * FROM backchannel_revoked_sids ORDER BY issuer, client_id, sid').all().map(r => ({ ...r })),
    })
    const before = snapshot()
    expect(before).toEqual({
      receipts: [{ issuer: evidence.issuer, client_id: evidence.clientId, jti: evidence.jti, digest: evidence.digest,
        sid: evidence.sid, sub: evidence.sub, accepted_at: NOW, expires_at: NOW + 120, retain_until: NOW + 1000 }],
      revoked: [{ issuer: evidence.issuer, client_id: evidence.clientId, sid: evidence.sid,
        sub: evidence.sub, revoked_at: NOW, retain_until: NOW + 1000 }],
    })
    expect(await store.accept({ ...evidence, sid: 'new-target', digest: 'conflict' }, NOW, NOW + 5000)).toBe('conflict')
    expect(snapshot()).toEqual(before)
    expect(await store.accept({ ...evidence, jti: 'new-jti', digest: 'new-digest', sub: 'other-sub' }, NOW, NOW + 5000)).toBe('conflict')
    expect(snapshot()).toEqual(before)
    expect(await store.accept(evidence, NOW + 1, NOW + 5000)).toBe('duplicate')
    expect(snapshot()).toEqual(before)
  })

  it('a tombstone write failure rolls back the receipt and allows a clean retry', async () => {
    const { db, raw } = testDbRaw(['backchannel'])
    const store = d1BackchannelStore(db)
    raw.exec(`CREATE TRIGGER reject_logout BEFORE INSERT ON backchannel_revoked_sids
      BEGIN SELECT RAISE(ABORT, 'simulated tombstone failure'); END`)
    await expect(store.accept(evidence, NOW, NOW + 1000)).rejects.toThrow(/^simulated tombstone failure$/)
    expect(raw.prepare('SELECT * FROM backchannel_receipts').all()).toEqual([])
    expect(raw.prepare('SELECT * FROM backchannel_revoked_sids').all()).toEqual([])
    raw.exec('DROP TRIGGER reject_logout')
    expect(await store.accept(evidence, NOW, NOW + 1000)).toBe('accepted')
    expect(await store.isRevoked(evidence, NOW)).toBe(true)
  })
})
