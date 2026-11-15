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
    expect(within(screen.getByRole('group', { name: 'Opens' })).getAllByRole('checkbox').map(c => (c as HTMLInputElement).checked)).toEqual([false, false])
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
        revokedAt: null, expiryEndsSessions: true, sessionsInvalidBefore: null, firstUsedAt: null, lastUsedAt: null, service: false, anon: false,
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
    within(screen.getByRole('article').querySelector('dd')!)
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

describe('anonymous and service links', () => {
  const ANON = "Anonymous: the recipient doesn't see this name or photo"
  const SERVICE_MINT = 'Service account: for a job, not a person (no email)'

  it('the mint form sends either flag, and a service link drops the email', async () => {
    const onMint = vi.fn(async (_: MintInput) => ({ id: 'g' }))
    renderWithQuery(<GrantMintForm scopes={[{ id: 'reports', label: 'Reports' }]} onMint={onMint} />)
    const user = userEvent.setup()
    await user.type(screen.getByRole('textbox', { name: 'Email' }), 'bob@example.com')
    await user.click(screen.getByRole('checkbox', { name: ANON }))
    await user.click(screen.getByRole('checkbox', { name: SERVICE_MINT }))
    expect((screen.getByRole('textbox', { name: 'Email' }) as HTMLInputElement).disabled).toBe(true)
    await user.click(screen.getByRole('button', { name: 'Mint link' }))
    expect(onMint.mock.calls).toEqual([[{
      name: null, email: null, scopes: ['reports'], maxRedeems: null, expiresInS: 30 * 86400, anon: true, service: true,
    }]])
  })

  it('a card tags each flag and toggles it on an existing link', async () => {
    const patches: unknown[] = []
    const client = backend(patches)
    await client.grants.mint({ name: 'Nightly scan', scopes: ['alpha'] })
    renderWithQuery(<GrantsPanel client={client} scopes={SCOPES} buildLink={() => 'x'} />)
    const card = await screen.findByRole('article')
    const user = userEvent.setup()
    await user.click(within(card).getByRole('checkbox', { name: 'Service account' }))
    await waitFor(() => expect(within(card).getByRole('heading').textContent).toBe('Nightly scan service'))
    await user.click(within(card).getByRole('checkbox', { name: ANON }))
    await waitFor(() => expect(within(card).getByRole('heading').textContent).toBe('Nightly scan anon service'))
    expect(patches).toEqual([{ service: true }, { anon: true }])
  })
})

describe('a link per page', () => {
  const pages = (g: Grant, t: string) => [
    { label: 'All roles', url: `https://x.test/?key=${t}` },
    ...g.scopes.map(s => ({ label: SCOPES.find(x => x.id === s)!.label, url: `https://x.test/${s}?key=${t}` })),
  ]

  it('shows a row per page with its own copy, and copies them all as labeled lines', async () => {
    renderWithQuery(<GrantsPanel client={backend()} scopes={SCOPES} buildLink={pages} />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('checkbox', { name: /^Alpha/ }))
    await user.click(screen.getByRole('checkbox', { name: 'Beta' }))
    await user.click(screen.getByRole('button', { name: 'Mint link' }))
    const rows = await screen.findAllByRole('textbox', { name: /^(All roles|Alpha|Beta)$/ })
    expect(rows.map(r => [r.getAttribute('aria-label'), (r as HTMLInputElement).value])).toEqual([
      ['All roles', 'https://x.test/?key=token-g1'],
      ['Alpha', 'https://x.test/alpha?key=token-g1'],
      ['Beta', 'https://x.test/beta?key=token-g1'],
    ])
    await user.click(screen.getAllByRole('button', { name: 'Copy' })[2]!)
    expect([await navigator.clipboard.readText(), screen.getAllByRole('button', { name: /^Cop/ }).map(b => b.textContent)])
      .toEqual(['https://x.test/beta?key=token-g1', ['Copy', 'Copy', 'Copied', 'Copy all']])
    await user.click(screen.getByRole('button', { name: 'Copy all' }))
    expect(await navigator.clipboard.readText()).toBe([
      'All roles: https://x.test/?key=token-g1',
      'Alpha: https://x.test/alpha?key=token-g1',
      'Beta: https://x.test/beta?key=token-g1',
    ].join('\n'))
    // A rotated link shows the same rows, with the new token.
    await user.click(screen.getByRole('button', { name: 'Done' }))
    await user.click(screen.getByRole('button', { name: 'Rotate' }))
    await user.click(screen.getByRole('button', { name: 'Kill the old link?' }))
    await waitFor(() => expect((screen.getByRole('textbox', { name: 'Beta' }) as HTMLInputElement).value).toBe('https://x.test/beta?key=rotated-g1'))
  })
})

describe('password managers', () => {
  const IGNORE = { autocomplete: 'off', 'data-1p-ignore': 'true', 'data-lpignore': 'true', 'data-bwignore': 'true' }
  const attrs = (el: HTMLElement) => Object.fromEntries(Object.keys(IGNORE).map(k => [k, el.getAttribute(k)]))

  it("are told to stay out of the recipient's fields, at mint and in the holder editor", async () => {
    const client = backend()
    await client.grants.mint({ name: 'For Bob', scopes: ['alpha'] })
    renderWithQuery(<GrantsPanel client={client} scopes={SCOPES} buildLink={() => 'x'} avatarEndpoint="/api/auth/avatar" />)
    const user = userEvent.setup()
    const card = await screen.findByRole('article')
    const mint = ['Memo', 'Holder', 'Email', 'Face'].map(name => attrs(screen.getAllByRole('textbox', { name })[0]!))
    await user.click(within(card).getByRole('button', { name: 'edit' }))
    const editor = within(card).getAllByRole('textbox').map(attrs)
    expect({ mint, editor }).toEqual({ mint: [IGNORE, IGNORE, IGNORE, IGNORE], editor: [IGNORE, IGNORE, IGNORE] })
  })
})

describe('anon wording follows the chip', () => {
  it.each([
    ['label', "Anonymous: the recipient doesn't see this name or photo"],
    ['pseudonym', 'Anonymous: the recipient sees a made-up name, not this name or photo'],
    ['hidden', 'Anonymous: the recipient sees no name, photo or account menu'],
  ] as const)('%s', async (anonChip, text) => {
    const client = backend()
    await client.grants.mint({ name: 'For Bob', scopes: ['alpha'] })
    renderWithQuery(<GrantsPanel client={client} scopes={SCOPES} buildLink={() => 'x'} anonChip={anonChip} />)
    await screen.findByRole('article')
    expect(screen.getAllByRole('checkbox', { name: /^Anonymous/ }).map(c => c.parentElement!.textContent)).toEqual([text, text])
  })
})
