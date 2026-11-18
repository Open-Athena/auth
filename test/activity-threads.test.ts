// disky's thread model in the package: one Slack thread per burst (parent, details, one reply per notify=line kind),
// posted as the actor, edited as the burst grows, resumed by a tab's session, and never posted twice.
import { afterEach, describe, expect, it } from 'vitest'
import { activityFeed, sessionTag, type ActivityEvent, type ActivityKinds } from '../src/activity/index.js'
import { slackActivitySink } from '../src/activity/slack.js'
import { d1ActivityStore } from '../src/adapters/d1-activity.js'
import { slotHash, slotMeta } from './activity-slot-tag.js'
import { testDbRaw } from './d1-shim.js'

const ORIGIN = 'https://app.example'
const actor = { id: 'grant:g1', name: 'Ada <Admin>', via: 'grant' }
const close: (() => void)[] = []
afterEach(() => { close.splice(0).forEach(done => done()) })

function setup(more: { timeZone?: string; kinds?: ActivityKinds } = {}) {
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
    ...(more.timeZone ? { timeZone: more.timeZone } : {}),
  })
  const feed = activityFeed({ store, sinks: [sink], now: () => clock, ...(more.kinds ? { kinds: more.kinds } : {}) })
  const record = (id: string, ts: number, kind: string, more: Partial<ActivityEvent> = {}) =>
    feed.record({ id, actor, origin: ORIGIN, ts, kind, sessionId: 'tab-1', ...more })
  /** The one saved thread, its `parts` parsed. */
  const state = () => {
    const [row, ...more] = raw.prepare('SELECT message_id, parts FROM activity_posts').all() as { message_id: string; parts: string }[]
    if (more.length) throw new Error('more than one thread')
    return { message_id: row!.message_id, state: JSON.parse(row!.parts) as unknown }
  }
  return {
    feed, record, calls, state,
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
    const details = `Pages: <${ORIGIN}/pm|/pm> → <${ORIGIN}/pm/2|/pm/2>\nSession: <${ORIGIN}/admin/sessions?sid=tab-1|🐳sj>`
    const errors = `*1 error*\n• 🐳sj <${ORIGIN}/admin/sessions?sid=tab-1|00:17> TypeError: &lt;b&gt;boom&lt;/b&gt; &amp; co on <${ORIGIN}/pm/2|/pm/2>`
    const key = `activity:staff:${burstId}`
    expect(t.calls).toEqual([
      ['chat.postMessage', { ...common, text: parent, ...as, metadata: slotMeta(key, null, parent) }],
      ['chat.postMessage', { ...common, thread_ts: '1.000', text: details, ...as, metadata: slotMeta(key, 'details', details) }],
      ['chat.postMessage', { ...common, thread_ts: '1.000', text: errors, ...as, metadata: slotMeta(key, 'kind:error', errors) }],
    ])
    expect(t.state()).toEqual({
      message_id: '1.000',
      state: {
        slots: { details: { ts: '2.000', hash: slotHash(key, 'details', details) }, 'kind:error': { ts: '3.000', hash: slotHash(key, 'kind:error', errors) } },
        channel: 'C1',
        parent: { ts: '1.000', hash: slotHash(key, null, parent) },
      },
    })

    t.calls.length = 0
    await t.record('e2', 1030, 'error', { line: 'TypeError: <b>boom</b> & co', path: '/pm/2' })
    await t.feed.deliver(burstId!)
    // The details reply didn't change, so it isn't touched.
    expect(t.calls.map(([m, b]) => [m, b.ts, b.text])).toEqual([
      ['chat.update', '1.000', parent.replace('1 error', '2 errors')],
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
      `Pages: <${ORIGIN}/pm|/pm> ×2\nSession: <${ORIGIN}/admin/sessions?sid=tab-1|🐳sj>`,
      `*1 resumption*\n• 🐳sj <${ORIGIN}/admin/sessions?sid=tab-1|02:16> after 2h 00m on <${ORIGIN}/pm|/pm>`,
    ])
  })

  it('a reply that fails is retried later without posting the parent or earlier replies again', async () => {
    const t = setup()
    const { burstId } = await t.record('e1', 1000, 'error', { line: 'boom', path: '/pm' })
    t.failOn(b => typeof b.text === 'string' && b.text.startsWith('*1 error*'))
    expect(await t.feed.deliver(burstId!).catch((e: Error) => e.message)).toBe('activity: Slack rejected message (ratelimited)')
    // Slack refused the reply outright, so nothing is pending: the parent and details are saved, with what they say.
    const key = `activity:staff:${burstId}`
    const [parent, details, errors] = t.calls.map(([, b]) => String(b.text))
    const saved = { parent: { ts: '1.000', hash: slotHash(key, null, parent!) }, details: { ts: '2.000', hash: slotHash(key, 'details', details!) } }
    expect(t.state()).toEqual({ message_id: '1.000', state: { slots: { details: saved.details }, channel: 'C1', parent: saved.parent } })
    t.calls.length = 0
    t.at(1030)
    await t.feed.flush()
    // Only the refused reply is sent; the parent and details didn't change.
    expect(t.calls.map(([m, b]) => [m, b.thread_ts, b.text])).toEqual([['chat.postMessage', '1.000', errors]])
    // The refused call took no Slack timestamp, so the retried reply is the third message.
    expect(t.state()).toEqual({
      message_id: '1.000',
      state: { slots: { details: saved.details, 'kind:error': { ts: '3.000', hash: slotHash(key, 'kind:error', errors!) } }, channel: 'C1', parent: saved.parent },
    })
  })

  it("several tabs share one thread, each line led by its session's tag; a server line takes the latest tab's", async () => {
    const t = setup()
    const { burstId } = await t.record('e1', 1000, 'error', { line: 'boom', path: '/a' })
    await t.record('e2', 1010, 'error', { line: 'boom', path: '/a', sessionId: 'tab-2' })
    await t.record('e3', 1020, 'error', { line: 'boom', path: '/a' })
    await t.record('e4', 1030, 'error', { line: 'quota exceeded', sessionId: undefined })
    await t.feed.deliver(burstId!)
    const s = (sid: string, hm: string) => `<${ORIGIN}/admin/sessions?sid=${sid}|${hm}>`
    expect([sessionTag('tab-1'), sessionTag('tab-2')]).toEqual(['🐳sj', '🐯uy'])
    expect(t.calls.slice(1).map(([, b]) => b.text)).toEqual([
      `Sessions: ${s('tab-1', '🐳sj')} · ${s('tab-2', '🐯uy')}`,
      [
        '*4 errors*',
        // Repeats fold within a tab, not across tabs.
        `• 🐳sj ${s('tab-1', '00:16')} boom on <${ORIGIN}/a|/a> ×2`,
        `• 🐯uy ${s('tab-2', '00:16')} boom on <${ORIGIN}/a|/a>`,
        `• 🐳sj ${s('tab-1', '00:17')} quota exceeded`,
      ].join('\n'),
    ])
  })

  it('shows times in the zone the app gives, with its abbreviation', async () => {
    const t = setup({ timeZone: 'America/New_York' })
    // 2026-11-15 01:18Z is 20:18 the evening before in New York.
    const at = Date.UTC(2026, 10, 15, 1, 18) / 1000
    t.at(at)
    const { burstId } = await t.record('e1', at, 'error', { line: 'boom' })
    await t.record('e2', at + 600, 'error', { line: 'boom' })
    await t.feed.deliver(burstId!)
    expect(t.calls.map(([, b]) => String(b.text).split('\n').at(-1))).toEqual([
      `share link · 2 errors · 2026-11-14 20:18–20:28 EST · <${ORIGIN}/admin/activity?burst=${burstId}|activity>`,
      `Session: <${ORIGIN}/admin/sessions?sid=tab-1|🐳sj>`,
      `• 🐳sj <${ORIGIN}/admin/sessions?sid=tab-1|20:18> boom ×2`,
    ])
    expect(() => setup({ timeZone: 'Mars/Olympus' })).toThrow(RangeError)
  })

  it("doesn't repeat itself: pages with their own reply leave the trail, and a line naming its page doesn't add it again", async () => {
    const t = setup({ kinds: { view: { record: 'line', notify: 'line' } } })
    const { burstId } = await t.record('v1', 1000, 'view', { line: 'view /rs', path: '/rs' })
    await t.record('v2', 1010, 'view', { path: '/jd' })
    await t.feed.deliver(burstId!)
    expect(t.calls.slice(1).map(([, b]) => b.text)).toEqual([
      `Session: <${ORIGIN}/admin/sessions?sid=tab-1|🐳sj>`,
      [
        '*2 page loads*',
        `• 🐳sj <${ORIGIN}/admin/sessions?sid=tab-1|00:16> <${ORIGIN}/rs|view /rs>`,
        `• 🐳sj <${ORIGIN}/admin/sessions?sid=tab-1|00:16> <${ORIGIN}/jd|/jd>`,
      ].join('\n'),
    ])
  })
})
