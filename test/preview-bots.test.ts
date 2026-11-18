// Link-preview bots (specs/done/link-preview-bots.md): an unfurler fetching a share link doesn't redeem it; it gets
// the link's card, a `preview` row is logged, and stats count it apart from the people who opened the link.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { accessLogActivity, activityFeed } from '../src/activity/index.js'
import { d1AuditQuery, d1AuditSink, d1GrantStore } from '../src/adapters/d1.js'
import { d1ActivityStore } from '../src/adapters/d1-activity.js'
import { previewBot } from '../src/core/bots.js'
import { createGate, type GateOptions } from '../src/core/gate.js'
import { testDb, testDbRaw } from './d1-shim.js'

const SECRET = 'test-secret-0123456789abcdef'
const NOW = Date.parse('2026-11-15T15:16:00Z')
const SLACK = 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)'
const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

describe('previewBot', () => {
  it.each([
    [SLACK, 'Slack'],
    ['Slack-ImgProxy (+https://api.slack.com/robots)', 'Slack'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_1) AppleWebKit/601.2.4 (KHTML, like Gecko) Version/9.0.1 Safari/601.2.4 facebookexternalhit/1.1 Facebot Twitterbot/1.0', 'iMessage'],
    ['facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)', 'Facebook'],
    ['TelegramBot (like TwitterBot)', 'Telegram'],
    ['Twitterbot/1.0', 'X'],
    ['LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)', 'LinkedIn'],
    ['Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)', 'Discord'],
    ['WhatsApp/2.23.20.0 A', 'WhatsApp'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)', 'Apple'],
    ['Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)', 'Google'],
    ['Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/56.0.2924.87 Safari/537.36 Google-PageRenderer Google (+https://developers.google.com/+/web/snippet/)', 'Google'],
    ['Mozilla/5.0 (Windows NT 6.1; WOW64) SkypeUriPreview Preview/0.5 skype-url-preview@microsoft.com', 'Microsoft'],
    ['Microsoft Office/16.0 (Windows NT 10.0; Microsoft Outlook 16.0.12026; Pro)', 'Microsoft'],
    ['http.rb/5.1.1 (Mastodon/4.2.0; +https://mastodon.social/)', 'Mastodon'],
    ['Mozilla/5.0 (compatible; Bluesky Cardyb/1.1; +mailto:support@bsky.app)', 'Bluesky'],
    ['Mimecast URL Protect', 'mail scanner'],
    ['Mozilla/5.0 (compatible; Embedly/0.2; +http://support.embed.ly/)', 'Embedly'],
    ['Iframely/1.3.1 (+https://iframely.com/docs/about) Atlassian', 'Iframely'],
    ['Mozilla/5.0 (compatible; ExampleCrawler/1.0)', 'bot'],
    ['ExampleBot/1.0', 'bot'],
    // People and jobs: browsers (a phone named "Cubot" included), scripts, no UA at all.
    [CHROME, null],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', null],
    ['Mozilla/5.0 (Linux; Android 12; Cubot X30) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36', null],
    ['curl/8.4.0', null],
    ['python-requests/2.31.0', null],
    ['', null],
    [null, null],
  ])('%s → %s', (ua, name) => {
    expect(previewBot(ua)).toBe(name)
  })
})

describe('a preview bot fetching a share link', () => {
  let db: D1Database
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    db = testDb()
  })
  afterEach(() => { vi.useRealTimers() })

  const gateWith = (more: Partial<GateOptions> = {}) =>
    createGate({ store: d1GrantStore(db), audit: d1AuditSink(db), secret: SECRET, adminEmails: ['boss@openathena.ai'], ...more })
  const get = (path: string, ua: string) => new Request(`https://jobs.example${path}`, { headers: { 'user-agent': ua, 'cf-connecting-ip': '3.80.0.1' } })
  const log = async () => (await db.prepare('SELECT event, grant_id AS grantId, path, reason FROM access_log ORDER BY id').all()).results

  it("doesn't redeem: it gets the link's card, a `preview` row is logged, and the key still works for the person", async () => {
    const gate = gateWith({ linkPreview: (req, grant) => ({ title: `${new URL(req.url).pathname} · ${grant.name}`, description: 'A role at <Open Athena>' }) })
    const { grant, token } = await gate.mint({ scopes: ['jd'], name: 'Hilary', maxRedeems: 1, createdBy: 'boss@openathena.ai' })
    const previews = await Promise.all(['/', '/sre', '/dir-eng-sf'].map(p => gate.redeem(token, get(`${p}?key=${token}`, SLACK))))
    const first = previews[0]!
    expect(previews.map(r => (r.ok ? 'redeemed' : r.reason === 'preview' ? r.bot : r.reason))).toEqual(['Slack', 'Slack', 'Slack'])
    expect(first.ok === false && first.reason === 'preview' ? [first.response.status, Object.fromEntries(first.response.headers), await first.response.text()] : null).toEqual([
      200,
      { 'cache-control': 'private, no-store', 'content-type': 'text/html; charset=utf-8', 'x-robots-tag': 'noindex, nofollow' },
      [
        '<!doctype html>',
        '<html><head><meta charset="utf-8">',
        '<meta name="robots" content="noindex, nofollow">',
        '<title>/ · Hilary</title>',
        '<meta property="og:title" content="/ · Hilary">',
        '<meta property="og:description" content="A role at &lt;Open Athena&gt;">',
        '<meta name="description" content="A role at &lt;Open Athena&gt;">',
        '<meta name="twitter:card" content="summary">',
        '</head><body></body></html>',
        '',
      ].join('\n'),
    ])
    const untouched = (await gate.list({ includeRevoked: true }))[0]!
    const human = await gate.redeem(token, get(`/sre?key=${token}`, CHROME))
    expect([untouched.redeems, untouched.firstUsedAt, human.ok]).toEqual([0, null, true])
    // The three previews ran concurrently, so their rows land in any order.
    const [mint, ...rest] = await log()
    const redeem = rest.pop()
    expect([mint, rest.sort((a, b) => String(a.path).localeCompare(String(b.path))), redeem]).toEqual([
      { event: 'mint', grantId: grant.id, path: null, reason: null },
      ['/', '/dir-eng-sf', '/sre'].map(path => ({ event: 'preview', grantId: grant.id, path, reason: 'Slack' })),
      { event: 'redeem', grantId: grant.id, path: '/sre', reason: null },
    ])
  })

  it('shows only the host without a hook, and gets nothing the key opens on a page that authenticates it directly', async () => {
    const gate = gateWith()
    const { token } = await gate.mint({ scopes: ['jd'], createdBy: 'boss@openathena.ai' })
    const r = await gate.redeem(token, get(`/sre?key=${token}`, SLACK))
    const direct = await gate.authenticateResult(get(`/sre?key=${token}`, SLACK))
    expect([
      r.ok === false && r.reason === 'preview' ? (await r.response.text()).split('\n').filter(l => l.includes('title')) : null,
      [direct.auth, direct.reason],
      (await log()).map(e => e.event),
    ]).toEqual([
      ['<title>jobs.example</title>', '<meta property="og:title" content="jobs.example">'],
      [null, null],
      ['mint', 'preview', 'preview'],
    ])
  })

  it("stats count previews apart, older bot redemptions included, and leave them out of who opened it", async () => {
    const gate = gateWith()
    const sink = d1AuditSink(db)
    const { grant, token } = await gate.mint({ scopes: ['jd'], createdBy: 'boss@openathena.ai' })
    const ts = Math.floor(NOW / 1000)
    // Before previews stopped redeeming: four Slack unfurls, from Ashburn.
    for (let i = 0; i < 4; i++) await sink.log({ ts, event: 'redeem', grantId: grant.id, ipHash: `aws-${i}`, ua: SLACK, country: 'US' })
    await db.prepare('UPDATE grants SET redeems = 5 WHERE id = ?').bind(grant.id).run()
    await gate.redeem(token, get(`/?key=${token}`, 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)'))
    await sink.log({ ts: ts + 60, event: 'redeem', grantId: grant.id, ipHash: 'home', ua: CHROME, country: 'GB' })
    expect(await d1AuditQuery(db).activity(grant.id)).toEqual({
      grantId: grant.id, distinctIps: 1, countries: ['GB'], views: 0, firstSeen: ts, lastSeen: ts + 60, topPaths: [],
      previews: 5, previewBots: ['Slack', 'Discord'], botRedeems: 4, staffClicks: [],
    })
  })

  it('the activity feed records a preview as its own kind, kept but not posted by default', async () => {
    const { db: adb, raw } = testDbRaw(['activity'])
    try {
      const feed = activityFeed({ store: d1ActivityStore(adb), now: () => Math.floor(NOW / 1000) })
      const record = accessLogActivity(feed, { origin: 'https://jobs.example', actor: () => ({ id: 'grant:g1', name: 'Hilary', via: 'grant' }) })
      const { burstId } = (await record('1', { ts: Math.floor(NOW / 1000), event: 'preview', grantId: 'g1', reason: 'Slack', path: '/sre' }))!
      const burst = (await d1ActivityStore(adb).get(burstId!))!
      expect([burst.counts, burst.notifyCounts, burst.lines.map(l => [l.kind, l.line, l.notify])]).toEqual([
        { preview: 1 }, {}, [['preview', 'Slack /sre', 'off']],
      ])
    } finally {
      raw.close()
    }
  })
})
