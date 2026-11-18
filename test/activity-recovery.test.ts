// The Slack activity sink on thrds' `syncSlots` (specs/done/adopt-thrds-toolkit.md): an interrupted post is adopted,
// not posted twice; a message deleted in Slack is posted again; an unchanged message isn't touched.
import { fakeChannel, fakeSlack, timeoutError, type Call } from '@open-athena/thrds/testing'
import { afterEach, describe, expect, it } from 'vitest'
import { activityFeed, type ActivityKinds } from '../src/activity/index.js'
import { slackActivitySink } from '../src/activity/slack.js'
import { d1ActivityStore } from '../src/adapters/d1-activity.js'
import { testDbRaw } from './d1-shim.js'

const ORIGIN = 'https://app.example'
const actor = { id: 'grant:g1', name: 'Ada', via: 'grant' }
const close: (() => void)[] = []
/** The fake channel's first message. */
const P = '101.000000'
afterEach(() => { close.splice(0).forEach(done => done()) })

/**
 * A feed posting to a fake channel. `refuse` answers a method itself (Slack's `ok: false` body) instead of the channel;
 * `afterCall` runs once a call has been answered, and may throw to make the answer look lost.
 */
function setup(hooks: { refuse?: Record<string, string>; afterCall?: (call: Call) => void } = {}) {
  const { db, raw } = testDbRaw(['activity'])
  close.push(() => raw.close())
  const store = d1ActivityStore(db)
  // Near the fake channel's own clock (its first message is 101.000000): recovery looks back from a post's start time.
  let clock = 100
  const channel = fakeChannel()
  const slack = fakeSlack({
    ...channel.routes,
    ...Object.fromEntries(Object.entries(hooks.refuse ?? {}).map(([method, error]) => [method, { body: { ok: false, error } }])),
  })
  const fetch = (async (url: string, init?: RequestInit) => {
    const response = await slack.fetch(url, init)
    hooks.afterCall?.(slack.calls.at(-1)!)
    return response
  }) as typeof globalThis.fetch
  const sink = slackActivitySink({ id: 'staff', staffOnly: true, token: 'fake-test-token', channel: 'C1', fetch })
  const kinds: ActivityKinds = { tick: { record: 'count', notify: 'off' } }
  const feed = activityFeed({ store, sinks: [sink], kinds, now: () => clock })
  let n = 0
  const record = (kind: string, more: { line?: string } = {}) =>
    feed.record({ id: `e${++n}`, actor, origin: ORIGIN, ts: clock, kind, sessionId: 'tab-1', ...more })
  /** Each call since the last look: its method, and the message it names (`ts`, else the thread it posts into). */
  let seen = 0
  const calls = () => slack.calls.splice(seen).map(c => [c.method, String(c.body.ts ?? c.body.thread_ts ?? '')])
  const post = () => raw.prepare('SELECT message_id FROM activity_posts').get() as { message_id: string | null }
  const fence = () => raw.prepare(`UPDATE activity_posts SET claim_token = 'someone-else'`).run()
  const flush = () => feed.flush().then(r => r.map(d => d.status), (e: Error) => e.message)
  return { feed, record, calls, post, fence, flush, messages: channel.messages, later: () => { clock += 3600 } }
}

describe('Slack activity recovery', () => {
  it('adopts a parent that landed though its reply was lost, and never posts it again', async () => {
    let lose = true
    const t = setup({ afterCall: call => { if (lose && call.method === 'chat.postMessage') { lose = false; throw timeoutError() } } })
    await t.record('error', { line: 'boom' })
    const first = await t.flush()
    const firstCalls = t.calls()
    t.later()
    expect([first, firstCalls, await t.flush(), t.calls(), t.messages.map(m => [m.ts, m.thread_ts ?? null]), t.post()]).toEqual([
      'activity: Slack timeout',
      [['chat.postMessage', '']],
      ['sent'],
      // Recovery finds the tagged parent; the parent is unchanged, so only the replies go out.
      [['auth.test', ''], ['conversations.history', ''], ['chat.postMessage', P], ['chat.postMessage', P]],
      [[P, null], ['102.000000', P], ['103.000000', P]],
      { message_id: P },
    ])
  })

  it('posts a parent deleted in Slack again, with its replies, and records the new one', async () => {
    const t = setup()
    await t.record('error', { line: 'boom' })
    await t.flush()
    t.messages.splice(0, 1)
    t.calls()
    await t.record('error', { line: 'boom again' })
    expect([await t.flush(), t.calls(), t.messages.map(m => [m.ts, m.thread_ts ?? null]), t.post()]).toEqual([
      ['sent'],
      [['chat.update', P], ['chat.postMessage', ''], ['chat.postMessage', '104.000000'], ['chat.postMessage', '104.000000']],
      [['102.000000', P], ['103.000000', P], ['104.000000', null], ['105.000000', '104.000000'], ['106.000000', '104.000000']],
      { message_id: '104.000000' },
    ])
  })

  it('posts a reply deleted in Slack again, alone, when its thread is still there', async () => {
    const t = setup()
    await t.record('error', { line: 'boom' })
    await t.flush()
    t.messages.splice(2, 1)
    t.calls()
    await t.record('error', { line: 'boom again' })
    expect([await t.flush(), t.calls(), t.messages.map(m => [m.ts, m.thread_ts ?? null])]).toEqual([
      ['sent'],
      // The reply's edit finds it gone; the thread is still there (`conversations.replies`), so only the reply is posted.
      [['chat.update', P], ['chat.update', '103.000000'], ['conversations.replies', P], ['auth.test', ''], ['chat.postMessage', P]],
      [[P, null], ['102.000000', P], ['104.000000', P]],
    ])
  })

  it('stops when another delivery took the burst over mid-send', async () => {
    let t: ReturnType<typeof setup>
    t = setup({ afterCall: call => { if (call.method === 'chat.postMessage' && call.body.thread_ts) t.fence() } })
    await t.record('error', { line: 'boom' })
    expect([await t.flush(), t.calls()]).toEqual(['activity: delivery lease lost', [['chat.postMessage', ''], ['chat.postMessage', P]]])
  })

  it('makes no Slack calls for an event nobody is notified of', async () => {
    const t = setup()
    await t.record('error', { line: 'boom' })
    await t.flush()
    t.calls()
    await t.record('tick')
    expect([await t.flush(), t.calls()]).toEqual([['sent'], []])
  })

  it('without a history scope, posts an interrupted parent again rather than wedging the burst', async () => {
    let lose = true
    const t = setup({
      refuse: { 'conversations.history': 'missing_scope' },
      afterCall: call => { if (lose && call.method === 'chat.postMessage') { lose = false; throw timeoutError() } },
    })
    await t.record('error', { line: 'boom' })
    await t.flush()
    t.calls()
    t.later()
    expect([await t.flush(), t.calls(), t.messages.map(m => [m.ts, m.thread_ts ?? null]), t.post()]).toEqual([
      ['sent'],
      [['auth.test', ''], ['conversations.history', ''], ['chat.postMessage', ''], ['chat.postMessage', '102.000000'], ['chat.postMessage', '102.000000']],
      [[P, null], ['102.000000', null], ['103.000000', '102.000000'], ['104.000000', '102.000000']],
      { message_id: '102.000000' },
    ])
  })
})
