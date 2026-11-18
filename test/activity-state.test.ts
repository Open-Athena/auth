// A threaded sink's saved progress (`ActivityThreadState`, specs/done/adopt-thrds-toolkit.md): thrds' `SlotState`,
// stored in `activity_posts.parts`, with rows saved before the upgrade read in the new shape.
import type { SlotState } from '@open-athena/thrds'
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest'
import { activityFeed, type ActivityThreadState } from '../src/activity/index.js'
import { d1ActivityStore } from '../src/adapters/d1-activity.js'
import { testDbRaw } from './d1-shim.js'

const close: (() => void)[] = []
afterEach(() => { close.splice(0).forEach(done => done()) })

/** A burst with a saved `activity_posts` row for sink `staff`, claimed as the next send would. */
async function claimed(messageId: string | null, parts: string) {
  const { db, raw } = testDbRaw(['activity'])
  close.push(() => raw.close())
  const store = d1ActivityStore(db)
  const feed = activityFeed({ store, now: () => 1000 })
  const { burstId } = await feed.record({ id: 'v1', actor: { id: 'grant:g1', name: 'Ada', via: 'grant' }, origin: 'https://app.example', ts: 1000, kind: 'view' })
  raw.prepare(`INSERT INTO activity_posts (burst_id, sink, message_id, parts, version) VALUES (?, 'staff', ?, ?, 0)`).run(burstId, messageId, parts)
  return (await store.claim(burstId!, 'staff', 1000, 60))?.state
}

describe('activity thread state', () => {
  it('is thrds’ `SlotState`', () => {
    expectTypeOf<ActivityThreadState>().toEqualTypeOf<SlotState>()
  })

  it('reads a row saved before the upgrade (flat `{ slot: ts }`) with unknown hashes', async () => {
    expect(await claimed('1.000', '{"details":"2.000","kind:error":"3.000"}')).toEqual({
      slots: { details: { ts: '2.000', hash: '' }, 'kind:error': { ts: '3.000', hash: '' } },
      parent: { ts: '1.000', hash: '' },
    })
  })

  it('takes the parent from `message_id`: none for a quiet burst, and the column wins when they disagree', async () => {
    const saved = JSON.stringify({ parent: { ts: '1.000', hash: 'h1' }, slots: { details: { ts: '2.000', hash: 'h2' } } })
    expect([await claimed('-', '{}'), await claimed('9.000', saved), await claimed('1.000', saved)]).toEqual([
      { slots: {} },
      { parent: { ts: '9.000', hash: '' }, slots: { details: { ts: '2.000', hash: 'h2' } } },
      { parent: { ts: '1.000', hash: 'h1' }, slots: { details: { ts: '2.000', hash: 'h2' } } },
    ])
  })
})
