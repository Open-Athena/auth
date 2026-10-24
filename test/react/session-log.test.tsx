// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://x.test/" }
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { FOREVER_MS, type SessionPage, type SwitchState } from '../../src/core/session-log-shape.js'
import { SessionList, SessionLogSwitch, SessionLogSwitchView, type SessionLogSwitchViewProps } from '../../src/react/session-log/index.js'
import { renderWithQuery, stubFetch } from './helpers.js'

const realFetch = globalThis.fetch
afterEach(() => {
  cleanup()
  globalThis.fetch = realFetch
})

const bounds = { defaultUntil: Date.UTC(2026, 9, 20), maxUntil: Date.UTC(2026, 10, 13) }
const OFF: SwitchState = { enabled: false, until: null, indefinite: false, reason: 'off', who: null, ts: null, ...bounds }
const ON: SwitchState = {
  enabled: true,
  until: Date.UTC(2026, 9, 15),
  indefinite: false,
  reason: null,
  who: 'ops@example.test',
  ts: Date.UTC(2026, 9, 12, 15) / 1000,
  ...bounds,
}

describe('SessionLogSwitchView', () => {
  const render = (state: SwitchState, o: Partial<SessionLogSwitchViewProps> = {}) =>
    renderToStaticMarkup(
      createElement(SessionLogSwitchView, {
        state,
        today: '2026-10-12',
        date: '2026-10-19',
        onDate: () => {},
        end: 'dated',
        onEnd: () => {},
        onSet: () => {},
        busy: false,
        error: null,
        ...o,
      }),
    )
  const SET = '<button type="submit">Set end</button>'
  const radio = (on: boolean) => `<input type="radio" name="oa-slog-end"${on ? ' checked=""' : ''}/>`
  const form = (checked: boolean, date: string, extra = '', indefinite = false) =>
    `<form><label class="oa-slog-toggle"><input type="checkbox" role="switch"${checked ? ' checked=""' : ''}/> Logging</label>` +
    '<span class="oa-slog-ends" role="radiogroup" aria-label="Ends">' +
    `<label>${radio(!indefinite)} through <input type="date" min="2026-10-12" max="2026-11-12" value="${date}"/> (UTC)</label>` +
    `<label>${radio(indefinite)} no end date</label></span>${extra}</form>`
  const section = (status: string, rest: string) =>
    `<section class="oa-slog-switch"><h2>Session log</h2><p class="oa-slog-status">${status}</p>${rest}</section>`
  const BY = ' Set by ops@example.test on 2026-10-12.'

  it('off; on through its last day; a changed end shows "Set end"; no end date; expired; not set up', () => {
    expect([
      render(OFF),
      render(ON, { date: '2026-10-14' }),
      render(ON, { date: '2026-10-20' }),
      render(ON, { date: '2026-10-14', end: 'indefinite' }),
      render({ ...ON, until: FOREVER_MS, indefinite: true }, { end: 'indefinite' }),
      render({ ...ON, enabled: false, reason: 'expired' }, { error: 'nope' }),
      render({ ...OFF, reason: 'not set up' }),
    ]).toEqual([
      section('Off.', form(false, '2026-10-19')),
      section(`On through 2026-10-14 (UTC).${BY}`, form(true, '2026-10-14')),
      section(`On through 2026-10-14 (UTC).${BY}`, form(true, '2026-10-20', SET)),
      section(`On through 2026-10-14 (UTC).${BY}`, form(true, '2026-10-14', SET, true)),
      section(`On (no end date).${BY}`, form(true, '2026-10-19', '', true)),
      section(`Off: ended after 2026-10-14 (UTC).${BY}`, `${form(false, '2026-10-19')}<p class="oa-slog-err">nope</p>`),
      section('Not set up on this deployment (no session_log tables): apply migrations/session-log/.', ''),
    ])
  })
})

describe('SessionLogSwitch', () => {
  it('turning it on PUTs the default end, then shows what the server says', async () => {
    const calls = stubFetch({ '/api/session-log/switch': { status: 200, body: OFF } })
    renderWithQuery(<SessionLogSwitch />)
    const toggle = await screen.findByRole('switch')
    const puts = stubFetch({ '/api/session-log/switch': { status: 200, body: { ...ON, until: Date.UTC(2026, 9, 20) } } })
    await userEvent.click(toggle)
    await screen.findByText('On through 2026-10-19 (UTC). Set by ops@example.test on 2026-10-12.')
    expect([calls, puts]).toEqual([
      [{ url: '/api/session-log/switch', method: 'GET', body: null }],
      [{ url: '/api/session-log/switch', method: 'PUT', body: { enabled: true, until: '2026-10-19' } }],
    ])
  })
})

describe('SessionList', () => {
  const T = Date.UTC(2026, 9, 12, 15)
  const row = (sid: string, email: string | null, via: string, errors = 0) => ({
    sid,
    email,
    via,
    build: 'abc123',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    started_ms: T - 60_000,
    last_ms: T,
    n_events: 12,
    n_errors: errors,
    n_batches: 1,
    first_url: '/',
    received_ts: T / 1000,
  })
  const page: SessionPage = {
    sessions: [row('sid-aaaaaa', 'ann@example.test', 'sso', 2), row('sid-bbbbbb', null, 'grant')],
    total: 2,
    offset: 0,
    prev: null,
    next: null,
  }

  it('lists sessions with links to each timeline; a filter re-queries the API from the first page', async () => {
    const calls = stubFetch({ '/api/session-log/sessions': { status: 200, body: page } })
    renderWithQuery(<SessionList sessionHref={sid => `/admin/sessions/${sid}`} />)
    const table = await screen.findByRole('table')
    await within(table).findByText('ann@example.test')
    const rows = within(table).getAllByRole('row').slice(1)
    expect(
      rows.map(r => [
        within(r).getAllByRole('cell')[0]!.textContent,
        within(r).getByRole('link').getAttribute('href'),
        within(r).getAllByRole('cell')[5]!.textContent,
        within(r).getAllByRole('cell')[6]!.textContent,
      ]),
    ).toEqual([
      ['ann@example.test', '/admin/sessions/sid-aaaaaa', '2', 'Chrome · macOS'],
      ['share link, no address', '/admin/sessions/sid-bbbbbb', '0', 'Chrome · macOS'],
    ])
    await userEvent.click(screen.getByRole('checkbox', { name: 'with errors' }))
    await waitFor(() => expect(calls.map(c => c.url)).toEqual(['/api/session-log/sessions', '/api/session-log/sessions?errors=1']))
  })
})
