import { describe, expect, it } from 'vitest'
import type { SessionRow, StoredEvent } from '../../src/core/session-log-shape.js'
import {
  fmtClock,
  fmtDuration,
  fmtOffset,
  pagerLabel,
  relAgo,
  sessionsQuery,
  ticks,
  timeline,
  uaLabel,
} from '../../src/react/session-log/model.js'

const T = 1_791_817_200_000
const e = (dt: number, k: StoredEvent['k'], f: Record<string, unknown> = {}, pid = 'p1'): StoredEvent =>
  ({ t: T + dt, k, pid, seq: 0, ...f }) as StoredEvent

describe('session view model', () => {
  // From disky r2 (`site/src/sessionsModel.test.ts`). The failure here ended offline, so it's an `offlineFailure`:
  // shown with its context and linked to the later success, but not an error.
  it('shows failure context and a later successful repeat', () => {
    const events = [
      e(0, 'life', { s: 'gap', ms: 48 * 60_000, on: true, vis: 'visible' }),
      e(0, 'api', { id: 7, u: '/api/series?path=marin-na', s: 0, ms: 2490, wall: 2490, end: T + 2490, err: 'TypeError: Failed to fetch', on0: true, on: false, vis0: 'visible', vis: 'hidden', visMs: 0, gapMs: 48 * 60_000, gapAgo: 0 }),
      e(4000, 'api', { id: 8, u: '/api/series?path=marin-na', s: 200, ms: 30, ray: '1234567890abcdef-EWR' }),
      e(5000, 'api', { id: 9, u: '/api/other', s: 0, ms: 5, wall: 5, end: T + 5005, err: 'TypeError: Failed to fetch', on0: true, on: true, vis0: 'visible', vis: 'visible', visMs: 5000 }),
    ]
    expect(timeline(events).map(({ text, error, lane }) => ({ text, error, lane }))).toEqual([
      { text: 'browser gap 48m 00s · online hint · visible', error: false, lane: 'page' },
      { text: 'GET /api/series?path=marin-na → failed · 2490ms · TypeError: Failed to fetch · request #7 · online hint → offline hint · visible → hidden · 0ms since visible · timer gap 48m 00s, 0ms before request', error: false, lane: 'api' },
      { text: 'GET /api/series?path=marin-na → 200 · 30ms · request #8 · Ray 1234567890abcdef-EWR · later success after request #7 (1s after failure)', error: false, lane: 'api' },
      { text: 'GET /api/other → failed · 5ms · TypeError: Failed to fetch · request #9 · online hint · visible · 5s since visible', error: true, lane: 'error' },
    ])
  })

  it.each([
    { name: 'another page load', first: {}, later: {}, pid: 'p2' },
    { name: 'a different query', first: {}, later: { u: '/api/a?path=b' } },
    { name: 'a masked URL', first: { u: '/api/a?key=…' }, later: { u: '/api/a?key=…' } },
    { name: 'a write', first: { m: 'POST' }, later: { m: 'POST' } },
    { name: 'an earlier concurrent read', first: { end: T + 5000 }, later: {} },
    { name: 'a cancelled read', first: { err: 'abort' }, later: {} },
  ])('does not label $name as a successful repeat', ({ first, later, pid }: { first: Record<string, unknown>; later: Record<string, unknown>; pid?: string }) => {
    const lines = timeline([
      e(0, 'api', { id: 1, u: '/api/a?path=a', s: 0, ms: 10, end: T + 10, err: 'TypeError: Failed to fetch', ...first }),
      e(1000, 'api', { id: 2, u: '/api/a?path=a', s: 200, ms: 20, ...later }, pid),
    ])
    expect(lines.at(-1)?.text).toEqual(`${later.m ?? 'GET'} ${later.u ?? '/api/a?path=a'} → 200 · 20ms · request #2`)
  })

  it('an app event never shows the server-side receipt time', () => {
    expect(timeline([e(0, 'movie.queued', { query: 'q=1', _received_ms: T + 1000 })]).map(l => l.text)).toEqual(['query: q=1'])
  })

  it('labels cancellations separately from network failures in the API lane', () => {
    const lines = timeline([
      e(0, 'api', { u: '/api/old-selection', s: 0, ms: 3, err: 'abort' }),
      e(1, 'api', { u: '/api/network', s: 0, ms: 4, err: 'TypeError: Failed to fetch' }),
    ])
    expect(lines.map(l => [l.lane, l.error, l.text])).toEqual([
      ['api', false, 'GET /api/old-selection → cancelled · 3ms'],
      ['error', true, 'GET /api/network → failed · 4ms · TypeError: Failed to fetch'],
    ])
  })
  it('keeps a failure nobody saw (offline, or received over a minute late) out of the error lane', () => {
    const fail = { u: '/api/x', s: 0, ms: 4, err: 'TypeError: Failed to fetch', online: true, visibility: 'visible' }
    const lines = timeline([
      e(0, 'api', { ...fail, _received_ms: T + 10_000 }),
      e(1, 'api', { ...fail, online: false, _received_ms: T + 10_000 }),
      e(2, 'api', { ...fail, _received_ms: T + 164_000 }),
      e(3, 'api', fail),
    ])
    expect(lines.map(l => [l.lane, l.error])).toEqual([['error', true], ['api', false], ['api', false], ['error', true]])
  })

  it('renders each kind as a line, with the URL in effect per page load and errors flagged', () => {
    const events = [
      e(0, 'start', { u: '/?d=2026-10-10', ref: 'https://discord.com/channels' }),
      e(0, 'viewport', { w: 390, h: 844, dpr: 3 }),
      e(1200, 'click', { n: 'bulk', l: 'trash' }),
      e(1300, 'click', { l: 'input', x: false }),
      e(2000, 'filter', { n: 'filter', q: 'ckpt' }),
      e(2500, 'nav', { u: '/a?d=2026-10-10&f=ckpt' }),
      e(2600, 'prefetch', { w: 'cover', p: '', d: '2026-10-10' }),
      e(2700, 'api', { u: '/api/subtree?path=a', s: 200, ms: 85, c: 'HIT', qe: 'pyrmts' }),
      e(2800, 'api', { m: 'POST', u: '/api/actions', b: { items: 2, kind: 'assign' }, s: 503, ms: 1200, err: 'phase2 timeout' }),
      e(2900, 'api', { u: '/api/down', s: 0, ms: 3, err: 'TypeError: Failed to fetch' }),
      // A second page load (a reload) starts its own URL state.
      e(3000, 'start', { u: '/b' }, 'p2'),
      e(3100, 'error', { msg: 'Uncaught TypeError: x is undefined', src: '/assets/index.js:1:2' }, 'p2'),
      e(3150, 'pick', { n: 'assign owner', v: 'ann' }),
      e(3200, 'reject', { msg: 'nope' }, 'p2'),
      e(3300, 'console', { msg: 'Warning: …' }, 'p2'),
      e(3400, 'vis', { s: 'hidden' }, 'p2'),
      e(3500, 'dropped', { n: 4 }, 'p2'),
    ]
    expect(timeline(events).map(l => [l.off, l.lane, l.error, l.url, l.text])).toEqual([
      [0, 'nav', false, '/?d=2026-10-10', 'page load /?d=2026-10-10 (from https://discord.com/channels)'],
      [0, 'page', false, '/?d=2026-10-10', '390×844 @3x'],
      [1200, 'input', false, '/?d=2026-10-10', '[bulk] trash'],
      [1300, 'input', false, '/?d=2026-10-10', 'input ☐'],
      [2000, 'input', false, '/?d=2026-10-10', 'filter = “ckpt”'],
      [2500, 'nav', false, '/a?d=2026-10-10&f=ckpt', '/a?d=2026-10-10&f=ckpt'],
      [2600, 'input', false, '/a?d=2026-10-10&f=ckpt', 'cover (root) @ 2026-10-10'],
      [2700, 'api', false, '/a?d=2026-10-10&f=ckpt', 'GET /api/subtree?path=a → 200 · 85ms · HIT · pyrmts'],
      [2800, 'error', true, '/a?d=2026-10-10&f=ckpt', 'POST /api/actions {items: 2, kind: assign} → 503 · 1200ms · phase2 timeout'],
      [2900, 'error', true, '/a?d=2026-10-10&f=ckpt', 'GET /api/down → failed · 3ms · TypeError: Failed to fetch'],
      [3000, 'nav', false, '/b', 'page load /b'],
      [3100, 'error', true, '/b', 'Uncaught TypeError: x is undefined @ /assets/index.js:1:2'],
      [3150, 'input', false, '/a?d=2026-10-10&f=ckpt', 'assign owner → ann'],
      [3200, 'error', true, '/b', 'unhandled rejection: nope'],
      [3300, 'error', true, '/b', 'console.error: Warning: …'],
      [3400, 'page', false, '/b', 'tab hidden'],
      [3500, 'page', false, '/b', '4 events dropped (cap)'],
    ])
  })

  it('places ticks by time across the width', () => {
    const lines = timeline([e(0, 'start', { u: '/' }), e(250, 'click', { l: 'x' }), e(1000, 'error', { msg: 'y' })])
    expect([ticks(lines, 400), ticks(timeline([e(0, 'start', { u: '/' })]), 400)]).toEqual([
      [
        { i: 0, x: 0, lane: 'nav', error: false },
        { i: 1, x: 100, lane: 'input', error: false },
        { i: 2, x: 400, lane: 'error', error: true },
      ],
      [{ i: 0, x: 0, lane: 'nav', error: false }],
    ])
  })

  it('formats wall-clock times to the ms, with the date only off the start day', () => {
    // T = 2026-10-12T15:00Z: 11:00 in New York, 00:00 the next day in Tokyo.
    expect([
      fmtClock(T, T, 'UTC'),
      fmtClock(T + 66_433, T, 'UTC'),
      fmtClock(T + 10 * 3_600_000 + 5, T, 'UTC'),
      fmtClock(T + 10 * 3_600_000 + 5, T, 'America/New_York'),
      fmtClock(T + 10 * 3_600_000 + 5, T, 'Asia/Tokyo'),
      fmtClock(T + 30 * 3_600_000, T, 'America/New_York'),
    ]).toEqual([
      '15:00:00.000',
      '15:01:06.433',
      'Oct 13 01:00:00.005',
      '21:00:00.005',
      '10:00:00.005',
      'Oct 13 17:00:00.000',
    ])
  })

  it('formats durations, offsets and user agents', () => {
    expect([
      [450, 12_000, 187_000, 3_720_000, 108 * 3_600_000 + 43 * 60_000].map(fmtDuration),
      [0, 62_345, 108 * 3_600_000 + 43 * 60_000].map(fmtOffset),
      [
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
        null,
      ].map(uaLabel),
    ]).toEqual([
      ['450ms', '12s', '3m 07s', '1h 02m', '4d 12h'],
      ['+0.000s', '+1m 02s', '+4d 12h'],
      ['Safari · iOS', 'Chrome · macOS', '—'],
    ])
  })

  it("an app's own events: their own lane, each field shown in the order sent", () => {
    const lines = timeline([
      e(0, 'start', { u: '/studio?q=x' }),
      e(500, 'movie.queued', { query: 'q=x', format: 'mp4' }),
      e(900, 'movie.failed', {}),
    ])
    expect(lines.map(l => [l.lane, l.error, l.text])).toEqual([
      ['nav', false, 'page load /studio?q=x'],
      ['app', false, 'query: q=x · format: mp4'],
      ['app', false, ''],
    ])
  })

  it('says how long ago, coarsely', () => {
    expect([0, 44_000, 50_000, 59 * 60_000, 3_600_000, 35 * 3_600_000, 36 * 3_600_000, 10 * 86_400_000].map(d => relAgo(T - d, T))).toEqual([
      'just now', 'just now', '1m ago', '59m ago', '1h ago', '35h ago', '2d ago', '10d ago',
    ])
  })
})

describe('session list paging', () => {
  it('the URL\'s filters and cursor → the API query (after wins over before; empties dropped)', () => {
    const none = { email: '', since: '', errors: false, after: null, before: null }
    expect([
      sessionsQuery(none),
      sessionsQuery({ ...none, email: 'ann', since: '2026-10-01', errors: true }),
      sessionsQuery({ ...none, errors: true, after: '1791817200000.sid-aaaaaa' }),
      sessionsQuery({ ...none, before: '1791817200000.sid-aaaaaa' }),
      sessionsQuery({ ...none, after: '1.sid-aaaaaa', before: '2.sid-bbbbbb' }),
    ]).toEqual([
      '',
      'email=ann&since=2026-10-01&errors=1',
      'errors=1&after=1791817200000.sid-aaaaaa',
      'before=1791817200000.sid-aaaaaa',
      'after=1.sid-aaaaaa',
    ])
  })
  it('the pager label: the page\'s range of the total', () => {
    const rows = (n: number) => Array.from({ length: n }, () => ({}) as SessionRow)
    expect([
      pagerLabel({ sessions: rows(50), total: 1234, offset: 0 }),
      pagerLabel({ sessions: rows(34), total: 1234, offset: 1200 }),
      pagerLabel({ sessions: [], total: 0, offset: 0 }),
      pagerLabel({ sessions: [], total: 12, offset: 12 }),
    ]).toEqual(['1–50 of 1,234', '1,201–1,234 of 1,234', '0 of 0', 'none of 12'])
  })
})
