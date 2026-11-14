import { describe, expect, it } from 'vitest'
import { activityFeed, type ActivityEvent, type ActivitySink } from '../src/activity/index.js'
import { d1ActivityStore } from '../src/adapters/d1-activity.js'
import { testDbRaw } from './d1-shim.js'

const actor = { id: 'grant:recipient-1', name: 'Recipient', via: 'grant' }
const event = (id: string, ts = 1000, kind = 'view'): ActivityEvent => ({
  id, actor, origin: 'https://app.example', ts, kind, line: '/report', path: '/report?token=private#fragment',
})

/** The SQLite shim yields within batch; D1 serializes transactions. Queue only batch boundaries, not store calls. */
function setup() {
  const { db, raw } = testDbRaw(['activity'])
  const batch = db.batch.bind(db)
  let tail = Promise.resolve()
  db.batch = ((statements: D1PreparedStatement[]) => {
    const result = tail.then(() => batch(statements))
    tail = result.then(() => {}, () => {})
    return result
  }) as D1Database['batch']
  return { store: d1ActivityStore(db), raw }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe('activity D1 ingestion', () => {
  it('groups one actor by gap and origin, and keeps replay first-write-wins', async () => {
    const { store, raw } = setup()
    const feed = activityFeed({ store, now: () => 5000 })
    const first = await feed.record(event('one'))
    const boundary = await feed.record(event('two', 1900))
    const separate = await feed.record(event('three', 2801))
    const otherOrigin = await feed.record({ ...event('four', 2802), origin: 'https://other.example' })
    const duplicate = await feed.record({ ...event('one', 9999), actor: { ...actor, name: 'Changed' } })
    expect(first.status).toBe('stored')
    expect(boundary).toEqual({ status: 'stored', burstId: first.burstId })
    expect(duplicate).toEqual({ status: 'duplicate', burstId: first.burstId })
    expect(new Set([first.burstId, separate.burstId, otherOrigin.burstId]).size).toBe(3)
    const burst = await store.get(first.burstId!)
    expect(burst).toEqual({
      id: first.burstId, actor, origin: 'https://app.example', firstTs: 1000, lastTs: 1900, receivedTs: 5000,
      version: 2, counts: { view: 2 }, notifyCounts: { view: 2 }, omittedLines: 0,
      lines: ['one', 'two'].map((id, index) => ({
        id, ts: index ? 1900 : 1000, kind: 'view', line: '/report', path: '/report', sessionId: null, notify: 'count',
      })),
    })
    expect(raw.prepare('SELECT COUNT(*) AS n FROM activity_bursts').get()).toEqual({ n: 3 })
  })

  it('serializes racing distinct events and deduplicates racing replay without a process-local store lock', async () => {
    const { store, raw } = setup()
    const feeds = Array.from({ length: 8 }, () => activityFeed({ store, now: () => 1000 }))
    const results = await Promise.all(feeds.map((feed, index) => feed.record(event(`race-${index % 4}`))))
    expect(results.map(r => r.status)).toEqual(['stored', 'stored', 'stored', 'stored', 'duplicate', 'duplicate', 'duplicate', 'duplicate'])
    expect(new Set(results.map(r => r.burstId)).size).toBe(1)
    const burst = await store.get(results[0]!.burstId!)
    expect({ counts: burst?.counts, version: burst?.version }).toEqual({ counts: { view: 4 }, version: 4 })
    expect(raw.prepare('SELECT COUNT(*) AS n FROM activity_bursts').get()).toEqual({ n: 1 })
  })

  it('rolls back burst creation if the event insert fails', async () => {
    const { store, raw } = setup()
    raw.exec("CREATE TRIGGER reject_activity BEFORE INSERT ON activity_events BEGIN SELECT RAISE(ABORT, 'test failure'); END")
    const feed = activityFeed({ store, now: () => 1000 })
    await expect(feed.record(event('one'))).rejects.toThrow('test failure')
    expect(raw.prepare('SELECT COUNT(*) AS n FROM activity_bursts').get()).toEqual({ n: 0 })
    expect(raw.prepare('SELECT COUNT(*) AS n FROM activity_events').get()).toEqual({ n: 0 })
  })

  it('drops count detail, persists kind settings, and leaves unknown/off kinds unrecorded', async () => {
    const { store, raw } = setup()
    const feed = activityFeed({ store, now: () => 1000, kinds: { custom: { record: 'off', notify: 'off' } } })
    const result = await feed.record({ ...event('count', 1000, 'click'), sessionId: 'tab-1' })
    expect(raw.prepare('SELECT kind, record, notify, line, path, session_id FROM activity_events').all()).toEqual([
      { kind: 'click', record: 'count', notify: 'count', line: null, path: null, session_id: null },
    ])
    expect(await store.get(result.burstId!)).toEqual({
      id: result.burstId, actor, origin: 'https://app.example', firstTs: 1000, lastTs: 1000, receivedTs: 1000,
      version: 1, counts: { click: 1 }, notifyCounts: { click: 1 }, lines: [], omittedLines: 0,
    })
    expect(await feed.record(event('off', 1000, 'custom'))).toEqual({ status: 'off', burstId: null })
    expect(await feed.record(event('unknown', 1000, 'constructor'))).toEqual({ status: 'off', burstId: null })
    await feed.setKind('click', { record: 'off', notify: 'off' })
    expect((await activityFeed({ store }).kinds()).click).toEqual({ record: 'off', notify: 'off' })
    await expect(feed.setKind('click', { record: 'count', notify: 'line' })).rejects.toThrow('activity: notify exceeds recording policy')
    expect(raw.prepare('SELECT COUNT(*) AS n FROM activity_events').get()).toEqual({ n: 1 })
  })

  it('keeps the latest bounded lines but exact counts', async () => {
    const { store } = setup()
    const feed = activityFeed({ store, now: () => 1000 })
    let id = ''
    for (let index = 0; index < 102; index++) id = (await feed.record(event(`line-${index}`, 1000 + index))).burstId!
    const burst = await store.get(id)
    expect({ count: burst?.counts, omitted: burst?.omittedLines, ids: burst?.lines.map(line => line.id) }).toEqual({
      count: { view: 102 }, omitted: 2, ids: Array.from({ length: 100 }, (_, index) => `line-${index + 2}`),
    })
  })
})

describe('activity delivery leases', () => {
  it('is record-only without explicit delivery, and no-sink delivery is a no-op', async () => {
    const { store, raw } = setup()
    const feed = activityFeed({ store, now: () => 1000 })
    const result = await feed.record(event('one'))
    expect(await feed.deliver(result.burstId!)).toEqual([])
    expect(await feed.flush()).toEqual([])
    expect(raw.prepare('SELECT * FROM activity_posts').all()).toEqual([])
  })

  it('allows one overlapping send, then edits after an event arrives in flight', async () => {
    const { store } = setup()
    const entered = deferred<void>()
    const finish = deferred<string>()
    const calls: { version: number; messageId: string | null }[] = []
    const sink: ActivitySink = {
      id: 'staff', staffOnly: true,
      async send(burst, messageId) {
        calls.push({ version: burst.version, messageId })
        if (calls.length === 1) { entered.resolve(); return finish.promise }
        return 'message-1'
      },
    }
    const feed = activityFeed({ store, now: () => 1000, sinks: [sink] })
    const first = await feed.record(event('one'))
    const inFlight = feed.deliver(first.burstId!)
    await entered.promise
    expect(await feed.deliver(first.burstId!)).toEqual([{ sink: 'staff', status: 'busy' }])
    await feed.record(event('two', 1001))
    finish.resolve('message-1')
    expect(await inFlight).toEqual([{ sink: 'staff', status: 'sent' }])
    expect(await store.pending('staff', 10)).toEqual([first.burstId])
    expect(await feed.flush()).toEqual([{ sink: 'staff', status: 'sent' }])
    expect(await feed.flush()).toEqual([])
    expect(calls).toEqual([{ version: 1, messageId: null }, { version: 2, messageId: 'message-1' }])
  })

  it('fences stale acknowledgements and releases only the owning lease', async () => {
    const { store } = setup()
    const feed = activityFeed({ store, now: () => 1000 })
    const first = await feed.record(event('one'))
    const claim = await store.claim(first.burstId!, 'staff', 1000, 10)
    expect(await store.claim(first.burstId!, 'staff', 1009, 10)).toBeNull()
    const takeover = await store.claim(first.burstId!, 'staff', 1010, 10)
    expect(takeover?.messageId).toBeNull()
    await store.release(first.burstId!, 'staff', claim!.token)
    expect(await store.claim(first.burstId!, 'staff', 1011, 10)).toBeNull()
    expect(await store.complete(first.burstId!, 'staff', claim!.token, 'stale', 1)).toBe(false)
    expect(await store.complete(first.burstId!, 'staff', takeover!.token, 'current', 1)).toBe(true)
    expect(await store.pending('staff', 10)).toEqual([])
  })

  it('retries failure, does not redeliver a successful sink, and isolates sink destinations', async () => {
    const { store } = setup()
    const calls: string[] = []
    let fail = true
    const sink = (id: string): ActivitySink => ({
      id, staffOnly: true,
      async send(_burst, messageId) {
        calls.push(`${id}:${messageId}`)
        if (id === 'two' && fail) { fail = false; throw new Error('mock failure') }
        return `${id}-message`
      },
    })
    let clock = 1000
    const feed = activityFeed({ store, now: () => clock, sinks: [sink('one'), sink('two')] })
    const first = await feed.record(event('one'))
    await expect(feed.deliver(first.burstId!)).rejects.toThrow('mock failure')
    clock = 1030
    expect(await feed.flush()).toEqual([{ sink: 'two', status: 'sent' }])
    expect(calls).toEqual(['one:null', 'two:null', 'two:null'])
  })

  it('backs a failing sink off per burst: 30s, doubling to 15 minutes, and reset by a success', async () => {
    const { store, raw } = setup()
    let clock = 1000
    let failing = true
    const calls: number[] = []
    const feed = activityFeed({ store, now: () => clock, leaseS: 10, sinks: [{
      id: 'staff', staffOnly: true,
      async send() {
        calls.push(clock)
        if (failing) throw new Error('mock failure')
        return 'message'
      },
    }] })
    const { burstId } = await feed.record(event('one'))
    /** Drain the way a request path does: attempt, and report the status or the error. */
    const drain = async (at: number) => {
      clock = at
      return feed.deliver(burstId!).then(r => r.map(d => d.status).join(), (e: Error) => e.message)
    }
    const retryAt = () => raw.prepare('SELECT claim_until, failures FROM activity_posts').get()
    expect([await drain(1000), await drain(1001), await drain(1029)]).toEqual(['mock failure', 'busy', 'busy'])
    expect(retryAt()).toEqual({ claim_until: 1030, failures: 1 })
    expect([await drain(1030), await drain(1089), await drain(1090)]).toEqual(['mock failure', 'busy', 'mock failure'])
    expect(retryAt()).toEqual({ claim_until: 1210, failures: 3 })
    for (const at of [1210, 1450, 1930, 2890]) await drain(at)
    expect(retryAt()).toEqual({ claim_until: 3790, failures: 7 })
    await drain(3790)
    expect(retryAt()).toEqual({ claim_until: 4690, failures: 8 })
    failing = false
    expect(await drain(4690)).toBe('sent')
    expect(retryAt()).toEqual({ claim_until: 0, failures: 0 })
    expect(calls).toEqual([1000, 1030, 1090, 1210, 1450, 1930, 2890, 3790, 4690])
  })
})

describe('activity retention', () => {
  it('protects live delivery and incrementally removes expired bursts, receipts and posts', async () => {
    const { store, raw } = setup()
    const feed = activityFeed({ store, now: () => 1000 })
    const first = await feed.record(event('one'))
    await feed.record(event('two', 1001))
    const claim = await store.claim(first.burstId!, 'staff', 1000, 60)
    expect(await store.purge(1001, 1059, 1)).toEqual({ events: 0, posts: 0, bursts: 0 })
    await store.release(first.burstId!, 'staff', claim!.token)
    expect(await store.purge(1001, 1060, 1)).toEqual({ events: 1, posts: 0, bursts: 0 })
    expect(await store.get(first.burstId!)).toBeNull()
    expect(await store.claim(first.burstId!, 'staff', 1060, 60)).toBeNull()
    const fresh = await feed.record(event('three', 1002))
    expect(fresh.burstId === first.burstId).toBe(false)
    expect(await store.purge(1000, 1060, 1)).toEqual({ events: 1, posts: 1, bursts: 1 })
    expect(raw.prepare('SELECT id FROM activity_events ORDER BY id').all()).toEqual([{ id: 'three' }])
    expect(await store.purge(1000, 1060, 1)).toEqual({ events: 0, posts: 0, bursts: 0 })
  })
})
