// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://x.test/" }
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAuthClient } from '../../src/client/api.js'
import type { Grant, GrantActivity, GrantUpdateInput, MintInput } from '../../src/core/http.js'
import { GrantMintForm, GrantsPanel, type CopyProps, type ExtraLinksProps } from '../../src/react/Grants.js'
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
      name: 'Board', subjectName: 'Ada', email: null, scopes: ['alpha', 'beta'], maxRedeems: null, expiresInS: 30 * 86400, keepToken: false,
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
function backend(patches: unknown[] = [], more: Partial<GrantActivity> = {}) {
  const grants: Grant[] = []
  /** Current key per link, and whether it's kept: the server's side of `GET/PUT/DELETE /grants/:id/token`. */
  const keys = new Map<string, string>()
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const path = String(input)
    const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
    if (path === '/api/auth/grants' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as MintInput
      const grant = {
        id: `g${grants.length + 1}`, name: body.name ?? null, note: null, subject: null, email: null, scopes: body.scopes,
        maxRedeems: null, redeems: 0, expiresAt: null, sessionTtlS: null, createdAt: 1, createdBy: 'a', disabledAt: null,
        revokedAt: null, expiryEndsSessions: true, sessionsInvalidBefore: null, firstUsedAt: null, lastUsedAt: null, service: false, anon: false, kept: !!body.keepToken,
      } satisfies Grant
      grants.push(grant)
      keys.set(grant.id, `token-${grant.id}`)
      return reply({ grant, token: `token-${grant.id}` })
    }
    const keyRoute = /^\/api\/auth\/grants\/([^/]+)\/token$/.exec(path)
    if (keyRoute) {
      const grant = grants.find(g => g.id === keyRoute[1])!
      if (init?.method === 'PUT') {
        if ((JSON.parse(String(init.body)) as { token: string }).token !== keys.get(grant.id)) return reply({ error: "that isn't this link's current key" }, 400)
        grant.kept = true
        return reply({ ok: true })
      }
      if (init?.method === 'DELETE') return reply({ ok: (grant.kept = false, true) })
      return grant.kept ? reply({ id: grant.id, token: keys.get(grant.id) }) : reply({ error: 'not kept' }, 404)
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
      return reply({ grantId: grant.id, distinctIps: 0, countries: [], views: 2, firstSeen: null, lastSeen: null, topPaths: [], previews: 0, previewBots: [], botRedeems: 0, staffClicks: [], ...more })
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
  /** What the card's "Copy link" icon copies, or null when there's none. */
  const link = async (user: ReturnType<typeof userEvent.setup>) => {
    const icon = screen.queryByRole('button', { name: 'Copy link' })
    if (!icon) return null
    await user.click(icon)
    return navigator.clipboard.readText()
  }

  it('mints, offers the app-shaped link once, and forgets it when dismissed', async () => {
    const { user, onChanged } = panel()
    await screen.findByText('Nothing yet')
    await user.click(screen.getByRole('checkbox', { name: 'Beta' }))
    await user.click(screen.getByRole('button', { name: 'Mint link' }))
    await screen.findByRole('button', { name: 'Copy link' })
    expect(await link(user)).toBe('https://x.test/beta/?key=token-g1')
    expect([onChanged.mock.calls.length, screen.getByRole('button', { name: 'Hide these links' }).parentElement!.textContent]).toEqual([
      1, "Copy these now: only the key's hash is stored, so they won't show again. ×",
    ])
    await user.click(screen.getByRole('button', { name: 'Hide these links' }))
    expect(await link(user)).toBe(null)
    expect(screen.getByText('Link shown once at mint. Rotate it for a fresh one if you lost it.')).toBeTruthy()
    expect(screen.getByRole('article').querySelector('dd')!.textContent).toBe('Beta')
    await waitFor(() => expect(within(screen.getByRole('article')).getByText('2')).toBeTruthy())
  })

  it('revoke and rotate each take a second click; revoking kills the showing link', async () => {
    const { user } = panel()
    await screen.findByText('Nothing yet')
    await user.click(screen.getByRole('checkbox', { name: 'Beta' }))
    await user.click(screen.getByRole('button', { name: 'Mint link' }))
    await screen.findByRole('button', { name: 'Copy link' })
    expect(await link(user)).toBe('https://x.test/beta/?key=token-g1')

    await user.click(screen.getByRole('button', { name: 'Rotate' }))
    await user.click(screen.getByRole('button', { name: 'Kill the old link?' }))
    await waitFor(async () => expect(await link(user)).toBe('https://x.test/beta/?key=rotated-g1'))

    await user.click(screen.getByRole('button', { name: 'Revoke' }))
    expect(screen.queryByText('revoked')).toBe(null)
    await user.click(screen.getByRole('button', { name: 'End every session?' }))
    await screen.findByText('revoked')
    expect(await link(user)).toBe(null)
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
      name: null, email: null, scopes: ['reports'], maxRedeems: null, expiresInS: 30 * 86400, anon: true, service: true, keepToken: false,
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

  it('offers each page, the key and all of them as name + icon pairs, and copies all as labeled lines', async () => {
    renderWithQuery(<GrantsPanel client={backend()} scopes={SCOPES} buildLink={pages} />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('checkbox', { name: /^Alpha/ }))
    await user.click(screen.getByRole('checkbox', { name: 'Beta' }))
    await user.click(screen.getByRole('button', { name: 'Mint link' }))
    const line = (await screen.findByRole('button', { name: 'Copy all' })).closest('p')!
    expect([line.textContent, within(line).getAllByRole('button').map(b => b.getAttribute('aria-label'))]).toEqual([
      'All roles  · Alpha  · Beta  · key  · all ', ['Copy link', 'Copy link', 'Copy link', 'Copy key', 'Copy all'],
    ])
    expect(screen.queryAllByRole('textbox').filter(t => (t as HTMLInputElement).readOnly)).toEqual([])
    const copy = async (i: number) => {
      await user.click(within(line).getAllByRole('button')[i]!)
      return navigator.clipboard.readText()
    }
    expect([await copy(2), await copy(3), await copy(4)]).toEqual([
      'https://x.test/beta?key=token-g1',
      '?key=token-g1',
      ['All roles: https://x.test/?key=token-g1', 'Alpha: https://x.test/alpha?key=token-g1', 'Beta: https://x.test/beta?key=token-g1', 'Key: ?key=token-g1'].join('\n'),
    ])
    expect(within(line).getAllByRole('button')[4]!.getAttribute('data-state')).toBe('copied')
    // A rotated link copies the new key.
    await user.click(screen.getByRole('button', { name: 'Rotate' }))
    await user.click(screen.getByRole('button', { name: 'Kill the old link?' }))
    await waitFor(async () => expect(await copy(3)).toBe('?key=rotated-g1'))
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

describe('links beside their scopes', () => {
  const pages = (g: Grant, t: string) => [
    { label: 'All roles', url: `https://x.test/?key=${t}` },
    ...g.scopes.map(s => ({ label: String(SCOPES.find(x => x.id === s)!.label), url: `https://x.test/${s}?key=${t}`, scope: s })),
  ]
  /** Each scope row's text and its icon's label, then the line under them. */
  const rows = (card: HTMLElement) => {
    const dd = card.querySelector('dd')!
    return [
      [...dd.querySelectorAll(':scope > label, :scope > div')].map(r => [r.textContent!.trim(), r.querySelector('.oa-ui-copy-btn')?.getAttribute('aria-label') ?? null]),
      card.querySelector('.oa-ui-links')?.textContent ?? null,
    ]
  }

  it("puts an icon on each scope's row, and follows the scope as it's checked and unchecked", async () => {
    renderWithQuery(<GrantsPanel client={backend()} scopes={SCOPES} buildLink={pages} editScopes />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('checkbox', { name: /^Alpha/ }))
    await user.click(screen.getByRole('button', { name: 'Mint link' }))
    const card = await screen.findByRole('article')
    await waitFor(() => expect(rows(card)).toEqual([[['Alpha', 'Copy link'], ['Beta', null]], 'All roles  · key  · all ']))
    await user.click(within(card).getByRole('checkbox', { name: 'Beta' }))
    await waitFor(() => expect(rows(card)).toEqual([[['Alpha', 'Copy link'], ['Beta', 'Copy link']], 'All roles  · key  · all ']))
    await user.click(within(card).getByRole('checkbox', { name: /^Alpha/ }))
    await waitFor(() => expect(rows(card)).toEqual([[['Alpha', null], ['Beta', 'Copy link']], 'All roles  · key  · all ']))
    // The Beta row's icon copies Beta's page; "Copy all" still lists every page, the scoped ones included.
    await user.click(within(card.querySelector('dd')!).getAllByRole('button', { name: 'Copy link' })[0]!)
    const beta = await navigator.clipboard.readText()
    await user.click(screen.getByRole('button', { name: 'Copy all' }))
    expect([beta, await navigator.clipboard.readText()]).toEqual([
      'https://x.test/beta?key=token-g1',
      ['All roles: https://x.test/?key=token-g1', 'Beta: https://x.test/beta?key=token-g1', 'Key: ?key=token-g1'].join('\n'),
    ])
  })

  it('without editScopes, the scopes become rows while there are links, and a list again once dismissed', async () => {
    renderWithQuery(<GrantsPanel client={backend()} scopes={SCOPES} buildLink={pages} />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('checkbox', { name: /^Alpha/ }))
    await user.click(screen.getByRole('checkbox', { name: 'Beta' }))
    await user.click(screen.getByRole('button', { name: 'Mint link' }))
    const card = await screen.findByRole('article')
    await waitFor(() => expect(rows(card)).toEqual([[['Alpha', 'Copy link'], ['Beta', 'Copy link']], 'All roles  · key  · all ']))
    await user.click(screen.getByRole('button', { name: 'Hide these links' }))
    expect([rows(card), card.querySelector('dd')!.textContent]).toEqual([[[], null], 'Alpha, Beta'])
  })
})

describe('kept keys', () => {
  const pages = (g: Grant, t: string) => [
    ...g.scopes.map(s => ({ label: String(SCOPES.find(x => x.id === s)!.label), url: `https://x.test/${s}?key=${t}`, scope: s })),
    { label: 'All roles', url: `https://x.test/?key=${t}` },
  ]

  it('the mint form offers the choice that isn\'t the default', async () => {
    const onMint = vi.fn(async (_: MintInput) => ({ id: 'g' }))
    renderWithQuery(<GrantMintForm scopes={[{ id: 'reports', label: 'Reports' }]} onMint={onMint} keepTokens />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Mint link' }))
    await user.click(screen.getByRole('checkbox', { name: "Forget the key after this (it's shown only once)" }))
    await user.click(screen.getByRole('button', { name: 'Mint link' }))
    expect(onMint.mock.calls.map(([i]) => i.keepToken)).toEqual([true, false])
  })

  it('a kept link offers its icons straight away, fetching the key once, on the first copy', async () => {
    const client = backend()
    const { grant } = await client.grants.mint({ name: 'For Hilary', scopes: ['alpha'], keepToken: true })
    const token = vi.spyOn(client.grants, 'token')
    renderWithQuery(<GrantsPanel client={client} scopes={SCOPES} buildLink={pages} />)
    const user = userEvent.setup()
    const card = await screen.findByRole('article')
    await waitFor(() => expect(within(card).queryAllByRole('button', { name: /^Copy/ }).length).toBe(4))
    expect([token.mock.calls.length, within(card).queryByRole('button', { name: 'Show links' }), within(card).queryByRole('button', { name: 'Hide these links' })]).toEqual([0, null, null])
    await user.click(within(card).getAllByRole('button', { name: 'Copy link' })[0]!)
    const alpha = await navigator.clipboard.readText()
    await user.click(within(card).getByRole('button', { name: 'Copy key' }))
    expect([alpha, await navigator.clipboard.readText(), token.mock.calls]).toEqual([
      `https://x.test/alpha?key=token-${grant.id}`, `?key=token-${grant.id}`, [[grant.id]],
    ])
    expect(within(card).getByText('Its key is kept, sealed; each fetch is logged.')).toBeTruthy()
    // Forgetting it takes the icons away.
    await user.click(within(card).getByRole('button', { name: 'forget key' }))
    await user.click(within(card).getByRole('button', { name: 'Only rotating brings it back. Forget?' }))
    await waitFor(() => expect(within(card).queryAllByRole('button', { name: /^Copy/ })).toEqual([]))
  })

  it('copies through a promised ClipboardItem where there is one, so Safari keeps the click', async () => {
    const client = backend()
    await client.grants.mint({ name: 'For Hilary', scopes: ['alpha'], keepToken: true })
    const written: string[] = []
    class FakeItem {
      constructor(readonly items: Record<string, Promise<Blob>>) {}
    }
    vi.stubGlobal('ClipboardItem', FakeItem)
    renderWithQuery(<GrantsPanel client={client} scopes={SCOPES} buildLink={pages} />)
    const user = userEvent.setup()
    const write = vi.spyOn(navigator.clipboard, 'write').mockImplementation(async items => {
      written.push(await (await (items[0] as unknown as FakeItem).items['text/plain']!).text())
    })
    try {
      const card = await screen.findByRole('article')
      await user.click(await within(card).findByRole('button', { name: 'Copy key' }))
      await waitFor(() => expect([write.mock.calls.length, written]).toEqual([1, ['?key=token-g1']]))
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("says so when the key can't be fetched, and tries again on the next click", async () => {
    const client = backend()
    await client.grants.mint({ name: 'For Hilary', scopes: ['alpha'], keepToken: true })
    const token = vi.spyOn(client.grants, 'token').mockRejectedValueOnce(new Error('offline'))
    renderWithQuery(<GrantsPanel client={client} scopes={SCOPES} buildLink={pages} />)
    const user = userEvent.setup()
    const card = await screen.findByRole('article')
    await user.click(await within(card).findByRole('button', { name: 'Copy key' }))
    await waitFor(() => expect(within(card).getAllByRole('alert').map(a => a.textContent)).toEqual(["Couldn't copy", 'offline']))
    await user.click(within(card).getByRole('button', { name: 'Copy key' }))
    await waitFor(async () => expect([await navigator.clipboard.readText(), token.mock.calls.length]).toEqual(['?key=token-g1', 2]))
  })

  it('takes replacement components, which get the copy behavior ready-made', async () => {
    const client = backend()
    await client.grants.mint({ name: 'For Hilary', scopes: ['alpha'], keepToken: true })
    const Copy = ({ name, copy }: CopyProps) => <button type="button" onClick={() => void copy()}>{`take ${name}`}</button>
    const ExtraLinks = ({ copies, Copy: C }: ExtraLinksProps) => <ul>{copies.map(c => <li key={c.kind + c.name}><C {...c} /></li>)}</ul>
    renderWithQuery(<GrantsPanel client={client} scopes={SCOPES} buildLink={pages} components={{ Copy, ExtraLinks }} />)
    const user = userEvent.setup()
    const card = await screen.findByRole('article')
    await waitFor(() => expect(within(card).getAllByRole('button', { name: /^take/ }).map(b => b.textContent)).toEqual(['take Alpha', 'take All roles', 'take key', 'take all']))
    await user.click(within(card).getByRole('button', { name: 'take Alpha' }))
    expect(await navigator.clipboard.readText()).toBe('https://x.test/alpha?key=token-g1')
  })

  it("an existing link's key is kept by pasting it, and a wrong one says so", async () => {
    const client = backend()
    const { grant } = await client.grants.mint({ name: 'For Hilary', scopes: ['alpha'] })
    renderWithQuery(<GrantsPanel client={client} scopes={SCOPES} buildLink={() => 'x'} />)
    const user = userEvent.setup()
    const card = await screen.findByRole('article')
    await user.click(within(card).getByRole('button', { name: "keep this link's key" }))
    await user.type(within(card).getByRole('textbox', { name: "This link's key" }), 'wrong')
    await user.click(within(card).getByRole('button', { name: 'Keep' }))
    await waitFor(() => expect(within(card).getByRole('alert').textContent).toBe("that isn't this link's current key"))
    await user.clear(within(card).getByRole('textbox', { name: "This link's key" }))
    await user.type(within(card).getByRole('textbox', { name: "This link's key" }), `token-${grant.id}`)
    await user.click(within(card).getByRole('button', { name: 'Keep' }))
    await waitFor(() => expect(within(card).getByText('Its key is kept, sealed; each fetch is logged.')).toBeTruthy())
  })
})

describe('preview bots on the card', () => {
  it('shows previews apart, and reads older bot redemptions as previews', async () => {
    const client = backend([], { previews: 4, previewBots: ['Slack'], botRedeems: 4 })
    const { grant } = await client.grants.mint({ name: 'For Hilary', scopes: ['alpha'] })
    // Five redemptions on the row, four of them Slack's from before previews stopped redeeming. (The fake PATCH
    // applies any field, which the real route wouldn't.)
    await client.grants.update(grant.id, { redeems: 5 } as GrantUpdateInput)
    renderWithQuery(<GrantsPanel client={client} scopes={SCOPES} buildLink={() => 'x'} />)
    const card = await screen.findByRole('article')
    await waitFor(() => expect(within(card).queryByText('previews')).toBeTruthy())
    const facts = [...card.querySelectorAll('dl > div')].map(d => [d.querySelector('dt')!.textContent, d.querySelector('dd')!.textContent])
    expect(facts.slice(0, 3)).toEqual([['scopes', 'Alpha'], ['redemptions', '1'], ['previews', '4 (Slack)']])
  })
})
