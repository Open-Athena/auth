// disky's thread model in the package: one Slack thread per burst (parent, details, one reply per notify=line kind),
// posted as the actor, edited as the burst grows, resumed by a tab's session, and never posted twice.
import { afterEach, describe, expect, it } from 'vitest'
import { activityFeed, type ActivityEvent } from '../src/activity/index.js'
import { slackActivitySink } from '../src/activity/slack.js'
import { d1ActivityStore } from '../src/adapters/d1-activity.js'
import { testDbRaw } from './d1-shim.js'

const ORIGIN = 'https://app.example'
const actor = { id: 'grant:g1', name: 'Ada <Admin>', via: 'grant' }
const close: (() => void)[] = []
afterEach(() => { close.splice(0).forEach(done => done()) })

function setup() {
  const { db, raw } = testDbRaw(['activity'])
  close.push(() => raw.close())
  const store = d1ActivityStore(db)
  let clock = 1000
  let ts = 0
  /** Slack's answers: fails the next call whose body matches, once. */
  let failNext: ((body: Record<string, unknown>) => boolean) | null = null
  const calls: [string, Record<string, unknown>][] = []
  const fetch = (async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    const method = String(url).replace('https://slack.com/api/', '')
    calls.push([method, body])
    if (failNext?.(body)) { failNext = null; return Response.json({ ok: false, error: 'ratelimited' }) }
    return Response.json({ ok: true, ts: method === 'chat.update' ? body.ts : `${++ts}.000` })
  }) as typeof globalThis.fetch
  const sink = slackActivitySink({
    id: 'staff', staffOnly: true, token: 'fake-test-token', channel: 'C1', fetch,
    actorSender: a => ({ username: a.name, iconUrl: 'https://img.example/ada.png' }),
    eventHref: line => (line.path ? `${ORIGIN}${line.path}` : null),
    sessionHref: sid => `${ORIGIN}/admin/sessions?sid=${sid}`,
    burstHref: b => `${ORIGIN}/admin/activity?burst=${b.id}`,
  })
  const feed = activityFeed({ store, sinks: [sink], now: () => clock })
  const record = (id: string, ts: number, kind: string, more: Partial<ActivityEvent> = {}) =>
    feed.record({ id, actor, origin: ORIGIN, ts, kind, sessionId: 'tab-1', ...more })
  const parts = () => raw.prepare('SELECT message_id, parts FROM activity_posts').all()
  return {
    feed, record, calls, parts,
    at: (s: number) => { clock = s },
    failOn: (f: (body: Record<string, unknown>) => boolean) => { failNext = f },
  }
}

describe('Slack activity threads', () => {
  it('posts a thread as the actor, saves each reply, and edits them all as the burst grows', async () => {
    const t = setup()
    const { burstId } = await t.record('v1', 1000, 'view', { line: '/pm', path: '/pm' })
    await t.record('n1', 1010, 'nav', { line: '/pm/2', path: '/pm/2' })
    await t.record('e1', 1020, 'error', { line: 'TypeError: <b>boom</b> & co', path: '/pm/2' })
    expect(await t.feed.deliver(burstId!)).toEqual([{ sink: 'staff', status: 'sent' }])
    const as = { username: 'Ada <Admin>', icon_url: 'https://img.example/ada.png' }
    const common = { channel: 'C1', parse: 'none', unfurl_links: false, unfurl_media: false }
    const parent = `share link · 1 page load · 1 URL change · 1 error · 1970-01-01 00:16–00:17Z · <${ORIGIN}/admin/activity?burst=${burstId}|activity>`
    const details = `Pages: <${ORIGIN}/pm|/pm> → <${ORIGIN}/pm/2|/pm/2>\n<${ORIGIN}/admin/sessions?sid=tab-1|session tab-1>`
    const errors = `*1 error*\n• <${ORIGIN}/admin/sessions?sid=tab-1|00:17> TypeError: &lt;b&gt;boom&lt;/b&gt; &amp; co on <${ORIGIN}/pm/2|/pm/2>`
    expect(t.calls).toEqual([
      ['chat.postMessage', { ...common, text: parent, ...as }],
      ['chat.postMessage', { ...common, thread_ts: '1.000', text: details, ...as }],
      ['chat.postMessage', { ...common, thread_ts: '1.000', text: errors, ...as }],
    ])
    expect(t.parts()).toEqual([{ message_id: '1.000', parts: JSON.stringify({ details: '2.000', 'kind:error': '3.000' }) }])

    t.calls.length = 0
    await t.record('e2', 1030, 'error', { line: 'TypeError: <b>boom</b> & co', path: '/pm/2' })
    await t.feed.deliver(burstId!)
    expect(t.calls.map(([m, b]) => [m, b.ts, b.text])).toEqual([
      ['chat.update', '1.000', parent.replace('1 error', '2 errors')],
      ['chat.update', '2.000', details],
      ['chat.update', '3.000', errors.replace('*1 error*', '*2 errors*').replace(/$/, ' ×2')],
    ])
  })

  it("a tab's session resumes its own burst after the gap, with a line saying after how long", async () => {
    const t = setup()
    const first = await t.record('v1', 1000, 'view', { line: '/pm', path: '/pm' })
    // Another tab of the same actor, an hour later: its own burst. An hour after that, the first tab comes back.
    const other = await t.record('v2', 1000 + 3600, 'view', { line: '/jd', path: '/jd', sessionId: 'tab-2' })
    const resumed = await t.record('v3', 1000 + 7200, 'view', { line: '/pm', path: '/pm' })
    expect([other.burstId === first.burstId, resumed.burstId === first.burstId]).toEqual([false, true])
    await t.feed.deliver(first.burstId!)
    expect(t.calls.map(([, b]) => b.text)).toEqual([
      `share link · 2 page loads · 1 resumption · 1970-01-01 00:16–02:16Z · <${ORIGIN}/admin/activity?burst=${first.burstId}|activity>`,
      `Pages: <${ORIGIN}/pm|/pm> ×2\n<${ORIGIN}/admin/sessions?sid=tab-1|session tab-1>`,
      `*1 resumption*\n• <${ORIGIN}/admin/sessions?sid=tab-1|02:16> after 2h 00m on <${ORIGIN}/pm|/pm>`,
    ])
  })

  it('a reply that fails is retried later without posting the parent or earlier replies again', async () => {
    const t = setup()
    const { burstId } = await t.record('e1', 1000, 'error', { line: 'boom', path: '/pm' })
    t.failOn(b => typeof b.text === 'string' && b.text.startsWith('*1 error*'))
    expect(await t.feed.deliver(burstId!).catch((e: Error) => e.message)).toBe('activity: Slack rejected message (ratelimited)')
    expect(t.parts()).toEqual([{ message_id: '1.000', parts: JSON.stringify({ details: '2.000' }) }])
    t.calls.length = 0
    t.at(1030)
    await t.feed.flush()
    expect(t.calls.map(([m, b]) => [m, b.ts ?? b.thread_ts])).toEqual([
      ['chat.update', '1.000'],
      ['chat.update', '2.000'],
      ['chat.postMessage', '1.000'],
    ])
    // The refused call took no Slack timestamp, so the retried reply is the third message.
    expect(t.parts()).toEqual([{ message_id: '1.000', parts: JSON.stringify({ details: '2.000', 'kind:error': '3.000' }) }])
  })
})
