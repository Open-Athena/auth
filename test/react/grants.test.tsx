// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://x.test/" }
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAuthClient } from '../../src/client/api.js'
import type { Grant, MintInput } from '../../src/core/http.js'
import { GrantMintForm, GrantsPanel } from '../../src/react/Grants.js'
import { renderWithQuery } from './helpers.js'

afterEach(cleanup)

const SCOPES = [
  { id: 'alpha', label: 'Alpha', hint: '0 of 622 sessions are visible to links' },
  { id: 'beta', label: 'Beta' },
]

describe('GrantMintForm', () => {
  const form = (scopes = SCOPES, onMint = vi.fn(async (_: MintInput) => ({ id: 'g' }))) => {
    renderWithQuery(<GrantMintForm scopes={scopes} onMint={onMint} />)
    return onMint
  }

  it('submits exactly the chosen scopes, in the order offered', async () => {
    const onMint = form()
    const user = userEvent.setup()
    expect(screen.getAllByRole('checkbox').map(c => (c as HTMLInputElement).checked)).toEqual([false, false])
    expect(screen.getByText('0 of 622 sessions are visible to links')).toBeTruthy()
    await user.click(screen.getByRole('checkbox', { name: 'Beta' }))
    await user.click(screen.getByRole('checkbox', { name: /^Alpha/ }))
    await user.type(screen.getByRole('textbox', { name: 'Memo' }), 'Board')
    await user.type(screen.getByRole('textbox', { name: 'Holder' }), ' Ada ')
    await user.click(screen.getByRole('button', { name: 'Mint link' }))
    expect(onMint.mock.calls).toEqual([[{
      name: 'Board', subjectName: 'Ada', email: null, scopes: ['alpha', 'beta'], maxRedeems: null, expiresInS: 30 * 86400,
    }]])
  })

  it('refuses no scopes, and says so', async () => {
    const onMint = form()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Mint link' }))
    expect(onMint.mock.calls).toEqual([])
    expect(screen.getByRole('alert').textContent).toBe('Choose at least one.')
    await user.click(screen.getByRole('checkbox', { name: 'Beta' }))
    expect(screen.queryByRole('alert')).toBe(null)
    await user.click(screen.getByRole('checkbox', { name: 'Beta' }))
    await user.click(screen.getByRole('button', { name: 'Mint link' }))
    expect(onMint.mock.calls).toEqual([])
  })

  it('a lone scope starts checked', async () => {
    const onMint = form([{ id: 'reports', label: 'Reports' }])
    await userEvent.setup().click(screen.getByRole('button', { name: 'Mint link' }))
    expect(onMint.mock.calls.map(([input]) => input.scopes)).toEqual([['reports']])
  })

  it('keeps what was typed when minting failed, and clears it when it worked', async () => {
    const results: unknown[] = [null, { id: 'g' }]
    const onMint = vi.fn(async () => results.shift())
    renderWithQuery(<GrantMintForm scopes={[{ id: 'r', label: 'R' }]} onMint={onMint} />)
    const user = userEvent.setup()
    const holder = screen.getByRole('textbox', { name: 'Holder' }) as HTMLInputElement
    await user.type(holder, 'Ada')
    await user.click(screen.getByRole('button', { name: 'Mint link' }))
    expect(holder.value).toBe('Ada')
    await user.click(screen.getByRole('button', { name: 'Mint link' }))
    await waitFor(() => expect(holder.value).toBe(''))
  })
})

/** The grant routes, in memory: enough to run the panel end to end. */
function backend(patches: unknown[] = []) {
  const grants: Grant[] = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const path = String(input)
    const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
    if (path === '/api/auth/grants' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as MintInput
      const grant = {
        id: `g${grants.length + 1}`, name: body.name ?? null, note: null, subject: null, email: null, scopes: body.scopes,
        maxRedeems: null, redeems: 0, expiresAt: null, sessionTtlS: null, createdAt: 1, createdBy: 'a', disabledAt: null,
        revokedAt: null, expiryEndsSessions: true, sessionsInvalidBefore: null, firstUsedAt: null, lastUsedAt: null,
      } satisfies Grant
      grants.push(grant)
      return reply({ grant, token: `token-${grant.id}` })
    }
    if (path === '/api/auth/grants') return reply({ grants })
    const patched = /^\/api\/auth\/grants\/([^/]+)$/.exec(path)
    if (patched && init?.method === 'PATCH') {
      patches.push(JSON.parse(String(init.body)))
      const grant = grants.find(g => g.id === patched[1])!
      Object.assign(grant, JSON.parse(String(init.body)))
      return reply({ grant })
    }
    const m = /^\/api\/auth\/grants\/([^/]+)\/(\w+)$/.exec(path)
    if (!m) return reply({ error: 'no route' }, 500)
    const grant = grants.find(g => g.id === m[1])!
    if (m[2] === 'activity') {
      return reply({ grantId: grant.id, distinctIps: 0, countries: [], views: 2, firstSeen: null, lastSeen: null, topPaths: [] })
    }
    if (m[2] === 'revoke') grant.revokedAt = 100
    if (m[2] === 'disable') grant.disabledAt = 100
    if (m[2] === 'enable') grant.disabledAt = null
    if (m[2] === 'rotate') return reply({ id: grant.id, token: `rotated-${grant.id}` })
    return reply({ ok: true })
  }
  return createAuthClient({ fetch })
}

describe('GrantsPanel', () => {
  const panel = () => {
    const onChanged = vi.fn()
    renderWithQuery(
      <GrantsPanel
        client={backend()}
        scopes={SCOPES}
        buildLink={(g, t) => `https://x.test/${g.scopes[0]}/?key=${t}`}
        onChanged={onChanged}
        emptyLabel="Nothing yet"
      />,
    )
    return { onChanged, user: userEvent.setup() }
  }
  const link = () => (screen.queryByRole('textbox', { name: 'Share link' }) as HTMLInputElement | null)?.value ?? null

  it('mints, shows the app-shaped link once, and forgets it when dismissed', async () => {
    const { user, onChanged } = panel()
    await screen.findByText('Nothing yet')
    await user.click(screen.getByRole('checkbox', { name: 'Beta' }))
    await user.click(screen.getByRole('button', { name: 'Mint link' }))
    await waitFor(() => expect(link()).toBe('https://x.test/beta/?key=token-g1'))
    expect(onChanged.mock.calls.length).toBe(1)
    await user.click(screen.getByRole('button', { name: 'Done' }))
    expect(link()).toBe(null)
    expect(screen.getByText('Link shown once at mint. Rotate it for a fresh one if you lost it.')).toBeTruthy()
    expect(screen.getByRole('article').querySelector('dd')!.textContent).toBe('Beta')
    await waitFor(() => expect(within(screen.getByRole('article')).getByText('2')).toBeTruthy())
  })

  it('revoke and rotate each take a second click; revoking kills the showing link', async () => {
    const { user } = panel()
    await screen.findByText('Nothing yet')
    await user.click(screen.getByRole('checkbox', { name: 'Beta' }))
    await user.click(screen.getByRole('button', { name: 'Mint link' }))
    await waitFor(() => expect(link()).toBe('https://x.test/beta/?key=token-g1'))

    await user.click(screen.getByRole('button', { name: 'Rotate' }))
    expect(link()).toBe('https://x.test/beta/?key=token-g1')
    await user.click(screen.getByRole('button', { name: 'Kill the old link?' }))
    await waitFor(() => expect(link()).toBe('https://x.test/beta/?key=rotated-g1'))

    await user.click(screen.getByRole('button', { name: 'Revoke' }))
    expect(screen.queryByText('revoked')).toBe(null)
    await user.click(screen.getByRole('button', { name: 'End every session?' }))
    await screen.findByText('revoked')
    expect(link()).toBe(null)
    expect(screen.queryByRole('button', { name: 'Disable' })).toBe(null)
  })

  it('disable and enable swap, with the note while disabled', async () => {
    const { user } = panel()
    await screen.findByText('Nothing yet')
    await user.click(screen.getByRole('checkbox', { name: 'Beta' }))
    await user.click(screen.getByRole('button', { name: 'Mint link' }))
    await user.click(await screen.findByRole('button', { name: 'Disable' }))
    await screen.findByText('No new redemptions; anyone already in stays in.')
    await user.click(await screen.findByRole('button', { name: 'Enable' }))
    await screen.findByRole('button', { name: 'Disable' })
    expect(screen.queryByText('No new redemptions; anyone already in stays in.')).toBe(null)
  })
})

describe('GrantsPanel editScopes', () => {
  const panel = async (editScopes: boolean, offered = SCOPES) => {
    const patches: unknown[] = []
    const client = backend(patches)
    await client.grants.mint({ name: 'Bob', scopes: ['alpha', 'retired'] })
    renderWithQuery(<GrantsPanel client={client} scopes={offered} editScopes={editScopes} buildLink={() => 'x'} />)
    await screen.findByRole('article')
    return { client, patches, user: userEvent.setup() }
  }
  /** Each scope checkbox on the card: `[name, checked, disabled]`. */
  const checks = () =>
    within(screen.getByRole('article'))
      .queryAllByRole('checkbox')
      .map(c => [(c as HTMLInputElement).closest('label')!.textContent, (c as HTMLInputElement).checked, (c as HTMLInputElement).disabled])

  it('shows no checkboxes unless asked', async () => {
    await panel(false)
    expect(checks()).toEqual([])
    expect(screen.getByRole('article').querySelector('dd')!.textContent).toBe('Alpha, retired')
  })

  it('lists a scope no longer offered, and keeps it when another changes', async () => {
    const { user, patches } = await panel(true)
    expect(checks()).toEqual([['Alpha', true, false], ['Beta', false, false], ['retired', true, false]])
    await user.click(within(screen.getByRole('article')).getByRole('checkbox', { name: 'Beta' }))
    await waitFor(() => expect(checks()).toEqual([['Alpha', true, false], ['Beta', true, false], ['retired', true, false]]))
    expect(patches).toEqual([{ scopes: ['alpha', 'beta', 'retired'] }])
    await user.click(within(screen.getByRole('article')).getByRole('checkbox', { name: 'Alpha' }))
    await waitFor(() => expect(patches).toEqual([{ scopes: ['alpha', 'beta', 'retired'] }, { scopes: ['beta', 'retired'] }]))
  })

  it("won't let the last one be unchecked", async () => {
    const { user, patches } = await panel(true)
    await user.click(within(screen.getByRole('article')).getByRole('checkbox', { name: 'Alpha' }))
    await waitFor(() => expect(checks()).toEqual([['Alpha', false, false], ['Beta', false, false], ['retired', true, true]]))
    await user.click(within(screen.getByRole('article')).getByRole('checkbox', { name: 'retired' }))
    expect(patches).toEqual([{ scopes: ['retired'] }])
  })

  it('is read-only on a revoked link', async () => {
    const { client } = await panel(true)
    const { grants } = await client.grants.list()
    await client.grants.revoke(grants[0]!.id)
    cleanup()
    renderWithQuery(<GrantsPanel client={client} scopes={SCOPES} editScopes buildLink={() => 'x'} />)
    await screen.findByText('revoked')
    expect(checks()).toEqual([])
  })
})
