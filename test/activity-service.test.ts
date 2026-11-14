// A service link's activity (service-grants §2): routine bursts post nothing; a notable one posts red with why; the
// next clean one after a red posts green; then quiet again.
import { afterEach, describe, expect, it } from 'vitest'
import { accessLogActivity, activityFeed, type ActivityEvent, type ActivityFeedOptions } from '../src/activity/index.js'
import { slackActivitySink } from '../src/activity/slack.js'
import { d1ActivityStore } from '../src/adapters/d1-activity.js'
import { testDbRaw } from './d1-shim.js'

const ORIGIN = 'https://app.example'
const actor = { id: 'grant:job', name: 'gcs scan', via: 'service' }
const HOUR = 3600
const close: (() => void)[] = []
afterEach(() => { close.splice(0).forEach(done => done()) })

function setup(service?: ActivityFeedOptions['service']) {
  const { db, raw } = testDbRaw(['activity'])
  close.push(() => raw.close())
  const store = d1ActivityStore(db)
  let ts = 0
  const posted: string[] = []
  const parents = new Set<string>()
  const fetch = (async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { text: string; ts?: string; thread_ts?: string }
    const edit = String(url).endsWith('update')
    const id = body.ts ?? `${++ts}.000`
    // Parents only: replies (details, error lines) are the thread model's, tested elsewhere.
    if (!edit && !body.thread_ts) parents.add(id)
    if (parents.has(id)) posted.push(`${edit ? 'edit' : 'post'}: ${body.text}`)
    return Response.json({ ok: true, ts: id })
  }) as typeof globalThis.fetch
  const sink = slackActivitySink({ id: 'staff', staffOnly: true, token: 'fake-test-token', channel: 'C1', fetch })
  let clock = 0
  const feed = activityFeed({ store, sinks: [sink], now: () => clock, ...(service ? { service } : {}) })
  let n = 0
  /** Record events at `at` (seconds) from `client`, then deliver that burst; returns the statuses. */
  const burst = async (at: number, kinds: string[], client = 'c1', more: Partial<ActivityEvent> = {}) => {
    clock = at
    let id = ''
    for (const kind of kinds) id = (await feed.record({ id: `e${++n}`, actor, origin: ORIGIN, ts: at, kind, line: `${kind} line`, path: '/scan', client, ...more })).burstId!
    return (await feed.deliver(id)).map(d => d.status)
  }
  return { feed, store, posted, burst, at: (s: number) => { clock = s } }
}

const when = (s: number) => `1970-01-01 ${new Date(s * 1000).toISOString().slice(11, 16)}Z`

describe('service link activity', () => {
  it('quiet when routine, red with why, green once clean again, then quiet', async () => {
    const t = setup()
    expect([
      await t.burst(1 * HOUR, ['view', 'view']),
      await t.burst(2 * HOUR, ['view', 'error', 'error', 'error']),
      await t.burst(3 * HOUR, ['view']),
      await t.burst(4 * HOUR, ['view']),
      await t.burst(5 * HOUR, ['view'], 'c2'),
      await t.burst(6 * HOUR, ['error', 'error']),
    ]).toEqual([['quiet'], ['sent'], ['sent'], ['quiet'], ['sent'], ['sent']])
    expect(t.posted).toEqual([
      `post: 🔴 3 errors · *gcs scan* (service) · 1 page load · 3 errors · ${when(2 * HOUR)}`,
      `post: 🟢 clean again · *gcs scan* (service) · 1 page load · ${when(3 * HOUR)}`,
      `post: 🔴 a new client · *gcs scan* (service) · 1 page load · ${when(5 * HOUR)}`,
      `post: 🟢 clean again · *gcs scan* (service) · 2 errors · ${when(6 * HOUR)}`,
    ])
    // Quiet bursts are delivered, not pending: a flush finds nothing to do.
    expect(await t.feed.flush()).toEqual([])
  })

  it('a quiet burst that turns notable as it grows is posted then, and a green one stays green as it grows', async () => {
    const t = setup()
    await t.burst(1 * HOUR, ['view'])
    expect([await t.burst(2 * HOUR, ['view']), await t.burst(2 * HOUR + 60, ['error', 'error', 'error'])]).toEqual([['quiet'], ['sent']])
    expect([await t.burst(4 * HOUR, ['view']), await t.burst(4 * HOUR + 60, ['view'])]).toEqual([['sent'], ['sent']])
    expect(t.posted).toEqual([
      `post: 🔴 3 errors · *gcs scan* (service) · 1 page load · 3 errors · 1970-01-01 02:00–02:01Z`,
      `post: 🟢 clean again · *gcs scan* (service) · 1 page load · ${when(4 * HOUR)}`,
      `edit: 🟢 clean again · *gcs scan* (service) · 2 page loads · 1970-01-01 04:00–04:01Z`,
    ])
  })

  it('a refused request is notable, with its reason, through the access-log bridge', async () => {
    const t = setup()
    t.at(1 * HOUR)
    const access = accessLogActivity(t.feed, { origin: ORIGIN, actor: () => actor })
    const { burstId } = (await access('row-1', { ts: 1 * HOUR, event: 'deny', reason: 'revoked', path: '/scan?key=secret', ipHash: 'h1', ua: 'curl/8' }))!
    expect(await t.feed.deliver(burstId!)).toEqual([{ sink: 'staff', status: 'sent' }])
    expect(t.posted).toEqual([`post: 🔴 1 refused request (revoked /scan) · *gcs scan* (service) · denied: 1 · ${when(1 * HOUR)}`])
  })

  it('the app can say what counts as notable', async () => {
    const t = setup({ notable: b => ((b.counts.view ?? 0) > 1 ? ['busier than usual'] : []) })
    expect([await t.burst(1 * HOUR, ['error', 'error', 'error']), await t.burst(2 * HOUR, ['view', 'view'])]).toEqual([['quiet'], ['sent']])
    expect(t.posted).toEqual([`post: 🔴 busier than usual · *gcs scan* (service) · 2 page loads · ${when(2 * HOUR)}`])
  })
})
