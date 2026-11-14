import { describe, expect, it } from 'vitest'
import { accessLogActivity, activityActorFromAuth, activityFeed, sessionLogActivity } from '../src/activity/index.js'
import { slackActivitySink } from '../src/activity/slack.js'
import { discordActivitySink } from '../src/activity/discord.js'
import { d1ActivityStore } from '../src/adapters/d1-activity.js'
import { createGate } from '../src/core/gate.js'
import { memoryGrantStore } from '../src/testing/index.js'
import { testDbRaw } from './d1-shim.js'

const actor = { id: 'grant:example', name: 'Recipient', via: 'grant' }
function setup() {
  const store = d1ActivityStore(testDbRaw(['activity']).db)
  return { store, feed: activityFeed({ store, now: () => 1000 }) }
}

describe('activity bridges', () => {
  it('uses a trusted recipient, never the private memo', async () => {
    const gate = createGate({ store: memoryGrantStore(), secret: 'test-secret', policy: () => null })
    const { grant } = await gate.mint({ name: 'Private staff memo', subject: { name: 'Recipient' }, scopes: ['view'], createdBy: 'staff' })
    expect(activityActorFromAuth({ kind: 'grant', grant, scopes: ['view'], admin: false })).toEqual({ id: `grant:${grant.id}`, name: 'Recipient', via: 'grant' })
    expect(activityActorFromAuth({ kind: 'grant', grant: { ...grant, subject: null }, scopes: ['view'], admin: false })).toEqual({ id: `grant:${grant.id}`, name: 'Unnamed recipient', via: 'grant' })
  })

  it('bridges retryable session batches with safe paths and clamped client time', async () => {
    const { store, feed } = setup()
    const hooks = sessionLogActivity(feed, { actor: () => actor, now: () => 1000 })
    const input: Parameters<typeof hooks.onStored>[0] = {
      who: { email: null, via: 'grant' }, req: new Request('https://app.example/api/log'),
      batch: { sid: 'tab-123', pid: 'page-123', seq: 0, build: 'test', events: [
        { t: 1_001_000, k: 'start', u: 'https://app.example/report?key=secret#private' },
        { t: 1_001_000, k: 'click', l: 'Private detail' },
      ] },
    }
    await hooks.onStored(input)
    await hooks.onStored(input)
    const [burst] = await store.list()
    expect({ actor: burst?.actor, ts: burst?.lastTs, counts: burst?.counts, lines: burst?.lines.map(e => [e.kind, e.line, e.path]) }).toEqual({
      actor, ts: 1000, counts: { view: 1, click: 1 }, lines: [['view', '/report', '/report']],
    })
  })

  it('bridges a failure the user saw as an error, and one reported a minute late as nothing', async () => {
    const { store, feed } = setup()
    const hooks = sessionLogActivity(feed, { actor: () => actor, now: () => 1000 })
    const fail = (t: number) => ({ t, k: 'api', u: '/api/x', s: 0, ms: 0, err: 'TypeError: Failed to fetch', online: true, visibility: 'visible' })
    await hooks.onStored({
      who: { email: null, via: 'grant' }, req: new Request('https://app.example/api/log'),
      batch: { sid: 'tab-123', pid: 'page-123', seq: 0, build: 'test', events: [fail(999_000), fail(939_000)] },
    })
    const [burst] = await store.list()
    expect({ counts: burst?.counts, lines: burst?.lines.map(e => [e.kind, e.line]) }).toEqual({ counts: { error: 1 }, lines: [['error', 'api 0']] })
  })

  it('bridges persisted access rows idempotently, including non-browser views', async () => {
    const { store, feed } = setup()
    const bridge = accessLogActivity(feed, { origin: 'https://app.example', actor: () => actor })
    const event = { ts: 1000, event: 'view' as const, path: '/report.pdf?key=secret' }
    await bridge('row-1', event)
    await bridge('row-1', event)
    const [burst] = await store.list()
    expect({ counts: burst?.counts, paths: burst?.lines.map(e => [e.line, e.path]) }).toEqual({ counts: { view: 1 }, paths: [['view /report.pdf', '/report.pdf']] })
  })
})

describe('activity sink protocols', () => {
  it('posts then edits a Slack message without mentions or raw detail at count level', async () => {
    const { store, feed } = setup()
    const result = await feed.record({ id: 'one', actor, origin: 'https://app.example', ts: 1000, kind: 'view', line: 'PRIVATE_DETAIL' })
    const burst = (await store.get(result.burstId!))!
    const calls: unknown[] = []
    const sink = slackActivitySink({ id: 'staff', staffOnly: true, token: 'fake-test-token', channel: 'C123', fetch: (async (url, init) => {
      calls.push([String(url), JSON.parse(String(init?.body))])
      return Response.json({ ok: true, ts: '123.456' })
    }) as typeof fetch })
    await sink.send(burst, null)
    await sink.send(burst, '123.456')
    const text = 'Recipient (grant)\n1970-01-01T00:16:40.000Z - 1970-01-01T00:16:40.000Z\nview: 1'
    const body = { channel: 'C123', text, blocks: [{ type: 'section', text: { type: 'plain_text', text, emoji: false } }], mrkdwn: false, parse: 'none', unfurl_links: false, unfurl_media: false }
    expect(calls).toEqual([
      ['https://slack.com/api/chat.postMessage', body],
      ['https://slack.com/api/chat.update', { ...body, ts: '123.456' }],
    ])
  })

  it('posts then edits via Discord webhook, suppressing all mention parsing', async () => {
    const { store, feed } = setup()
    const result = await feed.record({ id: 'one', actor, origin: 'https://app.example', ts: 1000, kind: 'view' })
    const burst = (await store.get(result.burstId!))!
    const calls: unknown[] = []
    const sink = discordActivitySink({ id: 'staff', staffOnly: true, webhook: 'https://discord.com/api/webhooks/123/test-secret', fetch: (async (url, init) => {
      calls.push([String(url), init?.method, JSON.parse(String(init?.body))])
      return Response.json({ id: 'message1' })
    }) as typeof fetch })
    await sink.send(burst, null)
    await sink.send(burst, 'message1')
    const body = { content: 'Recipient (grant)\n1970-01-01T00:16:40.000Z - 1970-01-01T00:16:40.000Z\nview: 1', allowed_mentions: { parse: [] } }
    expect(calls).toEqual([
      ['https://discord.com/api/webhooks/123/test-secret?wait=true', 'POST', body],
      ['https://discord.com/api/webhooks/123/test-secret/messages/message1', 'PATCH', body],
    ])
  })

  it("says why a sink refused, with only the platform's short error code", async () => {
    const { store, feed } = setup()
    const result = await feed.record({ id: 'one', actor, origin: 'https://app.example', ts: 1000, kind: 'view' })
    const burst = (await store.get(result.burstId!))!
    const failure = async (send: () => Promise<string>) => send().then(() => 'sent', (e: Error) => e.message)
    const slack = (reply: unknown) => slackActivitySink({ id: 'staff', staffOnly: true, token: 'fake-test-token', channel: 'C123', fetch: (async () => Response.json(reply)) as typeof fetch })
    const discord = (reply: Response) => discordActivitySink({ id: 'staff', staffOnly: true, webhook: 'https://discord.com/api/webhooks/123/test-secret', fetch: (async () => reply) as typeof fetch })
    expect(await Promise.all([
      failure(() => slack({ ok: false, error: 'not_in_channel' }).send(burst, null)),
      failure(() => slack({ ok: false, error: 'Bearer fake-test-token is bad' }).send(burst, null)),
      failure(() => slack({ ok: false, error: 'x'.repeat(65) }).send(burst, null)),
      failure(() => slack({ ok: false }).send(burst, null)),
      failure(() => discord(Response.json({ code: 10015, message: 'Unknown Webhook' }, { status: 404 })).send(burst, null)),
      failure(() => discord(new Response('<html>bad gateway</html>', { status: 502 })).send(burst, null)),
    ])).toEqual([
      'activity: Slack rejected message (not_in_channel)',
      'activity: Slack rejected message',
      'activity: Slack rejected message',
      'activity: Slack rejected message',
      'activity: Discord HTTP 404 (10015)',
      'activity: Discord HTTP 502',
    ])
  })
})
