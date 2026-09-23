// @vitest-environment jsdom
import { cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { AllowlistPanel } from '../../src/react/AllowlistPanel.js'
import { renderWithQuery, stubFetch } from './helpers.js'

const realFetch = globalThis.fetch
afterEach(() => {
  cleanup()
  globalThis.fetch = realFetch
})

const row = (email: string, source: string) => ({ email, scopes: ['view'], source, note: null, addedBy: null, updatedAt: 1 })

describe('AllowlistPanel — sync', () => {
  it('hides the button by default', async () => {
    stubFetch({ '/api/auth/allowed': { status: 200, body: { allowed: [] } } })
    renderWithQuery(<AllowlistPanel />)
    await screen.findByText('No one is on the allowlist yet.')
    expect(screen.queryByRole('button', { name: 'Sync now' })).toBeNull()
  })

  it('POSTs <endpoint>/sync, shows the per-group summary, and reloads the rows', async () => {
    const calls = stubFetch({
      '/api/auth/allowed': { status: 200, body: { allowed: [row('bo@x.test', 'sync:board@x.test')] } },
      '/api/auth/allowed/sync': { status: 200, body: { ok: true, result: [{ group: 'board@x.test', source: 'sync:board@x.test', count: 1 }] } },
    })
    renderWithQuery(<AllowlistPanel sync />)
    await userEvent.click(await screen.findByRole('button', { name: 'Sync now' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Synced: board@x.test (1)'))
    expect(calls.map(c => `${c.method} ${c.url}`)).toEqual([
      'GET /api/auth/allowed',
      'POST /api/auth/allowed/sync',
      'GET /api/auth/allowed',
    ])
    expect(screen.getAllByRole('row').map(r => r.textContent)).toEqual(['bo@x.testsyncedRemove'])
  })

  it('surfaces a failed sync as the error the route returned', async () => {
    stubFetch({
      '/api/auth/allowed': { status: 200, body: { allowed: [] } },
      '/api/auth/allowed/sync': { status: 502, body: { ok: false, error: 'google token endpoint: HTTP 401' } },
    })
    renderWithQuery(<AllowlistPanel sync />)
    await userEvent.click(await screen.findByRole('button', { name: 'Sync now' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('google token endpoint: HTTP 401'))
  })
})
