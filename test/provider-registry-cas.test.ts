import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { d1ClientRegistry } from '../src/adapters/d1-provider.js'
import type { ClientEvent, RegisteredClient } from '../src/provider/registry.js'
import { testDbRaw } from './d1-shim.js'

const CREATED_AT = 1_800_000_000
const ROTATED_AT = CREATED_AT + 60
const CLIENT: RegisteredClient = {
  id: 'cas-client',
  name: 'CAS client',
  secretHash: 'test-only-original-hash',
  redirectUris: ['https://cas.oa.dev/callback'],
  postLogoutRedirectUris: ['https://cas.oa.dev/'],
  disabledAt: null,
  createdAt: CREATED_AT,
  createdBy: 'creator',
  updatedAt: CREATED_AT,
  updatedBy: 'creator',
}
const CREATED: ClientEvent = {
  clientId: CLIENT.id,
  action: 'create',
  actor: 'creator',
  at: CREATED_AT,
  detail: JSON.stringify(CLIENT.redirectUris),
}
const databases: DatabaseSync[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const db of databases.splice(0)) db.close()
})

async function fixture() {
  const { db, raw } = testDbRaw(['provider'])
  databases.push(raw)
  // The shared shim awaits each statement. Queue whole batches so concurrent
  // callers cannot nest transactions on its single connection, just as in D1.
  const batch = db.batch.bind(db)
  let pending: Promise<unknown> = Promise.resolve()
  db.batch = <T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
    const result = pending.then(() => batch<T>(statements))
    pending = result.then(() => undefined, () => undefined)
    return result
  }
  const registry = d1ClientRegistry(db)
  vi.spyOn(Date, 'now').mockReturnValue(CREATED_AT * 1000)
  expect(await registry.create(CLIENT, CLIENT.createdBy)).toBe(true)
  expect(await registry.get(CLIENT.id)).toEqual(CLIENT)
  expect(await registry.events()).toEqual([CREATED])
  vi.mocked(Date.now).mockReturnValue(ROTATED_AT * 1000)
  const rotate = registry.rotateIfCurrent
  if (!rotate) throw new Error('D1 registry must support rotateIfCurrent')
  return { db, raw, registry, rotate }
}

describe('D1 client registry compare-and-swap rotation', () => {
  it('updates only the hash and update metadata, with one hash-free audit row', async () => {
    const { db, registry, rotate } = await fixture()
    const batch = vi.spyOn(db, 'batch')
    expect(await rotate(CLIENT.id, CLIENT.secretHash, 'test-only-new-hash', 'rotator')).toBe(true)
    expect(batch.mock.calls.map(([statements]) => statements.length)).toEqual([2])
    expect(await registry.get(CLIENT.id)).toEqual({
      ...CLIENT,
      secretHash: 'test-only-new-hash',
      updatedAt: ROTATED_AT,
      updatedBy: 'rotator',
    })
    expect(await registry.events()).toEqual([
      { clientId: CLIENT.id, action: 'rotate', actor: 'rotator', at: ROTATED_AT, detail: null },
      CREATED,
    ])
  })

  it('leaves the entire client and audit unchanged for a stale expected hash', async () => {
    const { registry, rotate } = await fixture()
    expect(await rotate(CLIENT.id, 'test-only-stale-hash', 'test-only-new-hash', 'stale')).toBe(false)
    expect(await registry.get(CLIENT.id)).toEqual(CLIENT)
    expect(await registry.events()).toEqual([CREATED])
  })

  it('does not create a missing client or an audit event', async () => {
    const { registry, rotate } = await fixture()
    expect(await rotate('missing', CLIENT.secretHash, 'test-only-new-hash', 'missing')).toBe(false)
    expect(await registry.get('missing')).toBeNull()
    expect(await registry.list()).toEqual([CLIENT])
    expect(await registry.events()).toEqual([CREATED])
  })

  it('rejects a duplicate retry without another event or metadata update', async () => {
    const { registry, rotate } = await fixture()
    expect(await rotate(CLIENT.id, CLIENT.secretHash, 'test-only-new-hash', 'rotator')).toBe(true)
    vi.mocked(Date.now).mockReturnValue((ROTATED_AT + 60) * 1000)
    expect(await rotate(CLIENT.id, CLIENT.secretHash, 'test-only-new-hash', 'retry')).toBe(false)
    expect(await registry.get(CLIENT.id)).toEqual({
      ...CLIENT,
      secretHash: 'test-only-new-hash',
      updatedAt: ROTATED_AT,
      updatedBy: 'rotator',
    })
    expect(await registry.events()).toEqual([
      { clientId: CLIENT.id, action: 'rotate', actor: 'rotator', at: ROTATED_AT, detail: null },
      CREATED,
    ])
  })

  it.each([['first', 'second'], ['second', 'first']])('allows only one concurrent contender: %s starts before %s', async (winner, loser) => {
    const { db, registry, rotate } = await fixture()
    const other = d1ClientRegistry(db)
    if (!other.rotateIfCurrent) throw new Error('D1 registry must support rotateIfCurrent')
    expect(await Promise.all([
      rotate(CLIENT.id, CLIENT.secretHash, `test-only-${winner}-hash`, winner),
      other.rotateIfCurrent(CLIENT.id, CLIENT.secretHash, `test-only-${loser}-hash`, loser),
    ])).toEqual([true, false])
    expect(await registry.get(CLIENT.id)).toEqual({
      ...CLIENT,
      secretHash: `test-only-${winner}-hash`,
      updatedAt: ROTATED_AT,
      updatedBy: winner,
    })
    expect(await registry.events()).toEqual([
      { clientId: CLIENT.id, action: 'rotate', actor: winner, at: ROTATED_AT, detail: null },
      CREATED,
    ])
  })

  it('rolls back the hash and metadata if the audit insert fails', async () => {
    const { raw, registry, rotate } = await fixture()
    raw.exec(`CREATE TRIGGER reject_rotation_audit BEFORE INSERT ON provider_client_events
      WHEN NEW.action = 'rotate' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`)
    await expect(rotate(CLIENT.id, CLIENT.secretHash, 'test-only-new-hash', 'rotator')).rejects.toThrow(/^audit unavailable$/)
    expect(await registry.get(CLIENT.id)).toEqual(CLIENT)
    expect(await registry.events()).toEqual([CREATED])
  })
})
