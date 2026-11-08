// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://admin.example/" }
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import type { ActivityBurst } from '../../src/activity/types.js'
import { ActivityAdmin, ActivityKindSettings, ActivityList } from '../../src/react/activity/index.js'
import { renderWithQuery } from './helpers.js'

const realFetch = globalThis.fetch
afterEach(() => { cleanup(); globalThis.fetch = realFetch })

const burst: ActivityBurst = {
  id: 'burst:one', actor: { id: 'actor:a', name: 'Alice', via: 'google' }, origin: 'https://app.example',
  firstTs: 1000, lastTs: 1060, receivedTs: 1100, version: 3, counts: { view: 1, click: 2 }, notifyCounts: { view: 1 }, omittedLines: 2,
  lines: [{ id: 'line:one', ts: 1000, kind: 'view', line: '<script>not markup</script>', path: '/report', sessionId: 'tab:one', notify: 'count' }],
}
interface Call { path: string; query: Record<string, string>; method: string; body: unknown; credentials: RequestCredentials | undefined; cache: RequestCache | undefined }
type Reply = { status?: number; body: unknown }
function network(reply: (call: Call) => Reply | Promise<Reply>) {
  const calls: Call[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), window.location.href)
    const call = { path: url.pathname, query: Object.fromEntries(url.searchParams), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) as unknown : null, credentials: init?.credentials, cache: init?.cache }
    calls.push(call)
    const response = await reply(call)
    return Response.json(response.body, { status: response.status ?? 200 })
  }) as typeof fetch
  return calls
}
const call = (path: string, query: Record<string, string> = {}, method = 'GET', body: unknown = null): Call => ({ path, query, method, body, credentials: 'same-origin', cache: 'no-store' })
const rows = (table: HTMLElement) => within(table).getAllByRole('row').map(row => Array.from(row.children).map(cell => cell.querySelector('time')?.getAttribute('datetime') ?? cell.textContent))

describe('Activity admin', () => {
  it('renders the exact burst table and detail as text, then closes detail', async () => {
    const user = userEvent.setup()
    const calls = network(req => ({ body: req.path.endsWith('/burst%3Aone') ? { burst } : { bursts: [burst] } }))
    renderWithQuery(<ActivityList />)
    const table = await screen.findByRole('table', { name: 'Recent activity bursts' })
    expect(rows(table)).toEqual([
      ['Actor', 'Origin', 'First seen', 'Last seen', 'Recorded', 'Detail'],
      ['Aliceactor:a / google', 'https://app.example', '1970-01-01T00:16:40.000Z', '1970-01-01T00:17:40.000Z', 'click: 2, view: 1', 'View'],
    ])
    await user.click(screen.getByRole('button', { name: 'View burst for Alice' }))
    const detail = await screen.findByRole('region', { name: 'Burst detail' })
    await within(detail).findByRole('heading', { name: 'Alice' })
    expect(Array.from(detail.querySelectorAll('p')).map(node => node.textContent)).toEqual([
      'actor:a / google', 'https://app.example', 'Recorded: click: 2, view: 1', 'Notifications: view: 1', '2 older lines omitted.',
    ])
    const line = within(detail).getByRole('listitem')
    expect([line.querySelector('time')?.getAttribute('datetime'), line.querySelector('strong')?.textContent, line.querySelector('span')?.textContent, line.querySelector('code')?.textContent, line.lastElementChild?.textContent, detail.querySelectorAll('script').length]).toEqual([
      '1970-01-01T00:16:40.000Z', 'view', '<script>not markup</script>', '/report', 'Session: tab:one', 0,
    ])
    expect(screen.getByRole('button', { name: 'Close burst for Alice' }).getAttribute('aria-expanded')).toBe('true')
    await user.click(screen.getByRole('button', { name: 'Close burst for Alice' }))
    expect(screen.queryByRole('region', { name: 'Burst detail' })).toBe(null)
    expect(calls).toEqual([call('/api/activity', { limit: '100' }), call('/api/activity/burst%3Aone')])
  })

  it('applies accessible filters, clears the selection, and refreshes the same query', async () => {
    const user = userEvent.setup()
    const calls = network(req => ({ body: req.path.endsWith('/burst%3Aone') ? { burst } : { bursts: req.query.actorId ? [] : [burst] } }))
    renderWithQuery(<ActivityList endpoint="/staff/activity/" />)
    await user.click(await screen.findByRole('button', { name: 'View burst for Alice' }))
    await screen.findByRole('heading', { name: 'Alice' })
    await user.type(screen.getByRole('searchbox', { name: 'Actor ID' }), 'actor:a')
    await user.type(screen.getByRole('searchbox', { name: 'Origin' }), 'https://app.example')
    fireEvent.change(screen.getByLabelText('Active since'), { target: { value: '2026-01-01T00:00' } })
    await user.selectOptions(screen.getByRole('combobox', { name: 'Limit' }), '25')
    expect(calls.length).toBe(2)
    await user.click(screen.getByRole('button', { name: 'Apply filters' }))
    expect((await screen.findByText('No activity matches these filters.')).getAttribute('role')).toBe('status')
    expect(screen.queryByRole('region', { name: 'Burst detail' })).toBe(null)
    await waitFor(() => expect((screen.getByRole('button', { name: 'Refresh' }) as HTMLButtonElement).disabled).toBe(false))
    await user.click(screen.getByRole('button', { name: 'Refresh' }))
    const query = { actorId: 'actor:a', origin: 'https://app.example', since: String(Math.floor(new Date('2026-01-01T00:00').getTime() / 1000)), limit: '25' }
    await waitFor(() => expect(calls).toEqual([call('/staff/activity', { limit: '100' }), call('/staff/activity/burst%3Aone'), call('/staff/activity', query), call('/staff/activity', query)]))
  })

  it('shows loading and then independent empty states', async () => {
    let resolve!: (value: Reply) => void
    network(() => new Promise<Reply>(done => { resolve = done }))
    renderWithQuery(<ActivityList />)
    expect(screen.getByRole('status').textContent).toBe('Loading activity...')
    resolve({ body: { bursts: [] } })
    expect((await screen.findByText('No activity matches these filters.')).textContent).toBe('No activity matches these filters.')
    cleanup()
    network(() => ({ body: { kinds: {} } }))
    renderWithQuery(<ActivityKindSettings />)
    expect((await screen.findByRole('status')).textContent).toBe('Loading kind settings...')
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('No activity kinds configured.'))
  })

  it.each([401, 403, 500])('shows controlled read errors without retry loops (%s)', async status => {
    const calls = network(() => ({ status, body: { error: 'Staff access required' } }))
    renderWithQuery(<ActivityAdmin />)
    await waitFor(() => expect(screen.getAllByRole('alert').map(node => node.textContent)).toEqual(['Staff access required', 'Staff access required']))
    expect(screen.queryAllByRole('table')).toEqual([])
    expect(calls).toEqual([call('/api/activity', { limit: '100' }), call('/api/activity/kinds')])
  })

  it('clamps notification detail to recording, saves an exact policy, and updates cached settings', async () => {
    const user = userEvent.setup()
    const initial = { view: { record: 'line', notify: 'line' }, click: { record: 'count', notify: 'count' } }
    const calls = network(req => ({ body: { kinds: req.method === 'PUT' ? { ...initial, view: req.body } : initial } }))
    renderWithQuery(<ActivityKindSettings />)
    const record = await screen.findByRole('combobox', { name: 'Record view' })
    expect(rows(screen.getByRole('table'))).toEqual([
      ['Kind', 'Record', 'Notify', 'Save'], ['click', 'offcountline', 'offcountline', 'Save'], ['view', 'offcountline', 'offcountline', 'Save'],
    ])
    await user.selectOptions(record, 'count')
    const notify = screen.getByRole('combobox', { name: 'Notify view' }) as HTMLSelectElement
    expect({ record: (record as HTMLSelectElement).value, notify: notify.value, disabled: Array.from(notify.options).map(option => [option.value, option.disabled]) }).toEqual({ record: 'count', notify: 'count', disabled: [['off', false], ['count', false], ['line', true]] })
    await user.click(screen.getByRole('button', { name: 'Save view policy' }))
    await waitFor(() => expect((screen.getByRole('button', { name: 'Save view policy' }) as HTMLButtonElement).disabled).toBe(true))
    expect(calls).toEqual([call('/api/activity/kinds'), call('/api/activity/kinds/view', {}, 'PUT', { record: 'count', notify: 'count' })])
    expect((screen.getByRole('combobox', { name: 'Record view' }) as HTMLSelectElement).value).toBe('count')
  })

  it('keeps the attempted policy on save failure and allows retry after a pending write', async () => {
    const user = userEvent.setup()
    let finish!: (value: Reply) => void
    const initial = { view: { record: 'line', notify: 'count' } }
    const calls = network(req => req.method === 'PUT' ? new Promise<Reply>(done => { finish = done }) : { body: { kinds: initial } })
    renderWithQuery(<ActivityKindSettings />)
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Record view' }), 'off')
    await user.click(screen.getByRole('button', { name: 'Save view policy' }))
    await waitFor(() => expect((screen.getByRole('combobox', { name: 'Record view' }) as HTMLSelectElement).disabled).toBe(true))
    expect(screen.getByRole('button', { name: 'Save view policy' }).textContent).toBe('Saving...')
    finish({ status: 403, body: { error: 'Policy change refused' } })
    expect((await screen.findByRole('alert')).textContent).toBe('Policy change refused')
    expect([(screen.getByRole('combobox', { name: 'Record view' }) as HTMLSelectElement).value, (screen.getByRole('combobox', { name: 'Notify view' }) as HTMLSelectElement).value]).toEqual(['off', 'off'])
    await user.click(screen.getByRole('button', { name: 'Save view policy' }))
    finish({ body: { kinds: { view: { record: 'off', notify: 'off' } } } })
    await waitFor(() => expect(screen.queryByRole('alert')).toBe(null))
    expect(calls).toEqual([call('/api/activity/kinds'), call('/api/activity/kinds/view', {}, 'PUT', { record: 'off', notify: 'off' }), call('/api/activity/kinds/view', {}, 'PUT', { record: 'off', notify: 'off' })])
  })

  it('reports detail failures without losing the list', async () => {
    const user = userEvent.setup()
    network(req => req.path.endsWith('/burst%3Aone') ? { status: 404, body: { error: 'Burst no longer available' } } : { body: { bursts: [burst] } })
    renderWithQuery(<ActivityList />)
    await user.click(await screen.findByRole('button', { name: 'View burst for Alice' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Burst no longer available')
    expect(screen.getAllByRole('table').length).toBe(1)
  })
})
