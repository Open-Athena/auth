// @vitest-environment jsdom
import { cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { ProfilePanel } from '../../src/react/ProfilePanel.js'
import type { Whoami } from '../../src/react/types.js'
import { renderWithQuery, stubFetch } from './helpers.js'

const realFetch = globalThis.fetch
afterEach(() => {
  cleanup()
  globalThis.fetch = realFetch
})

const FACE = 'data:image/png;base64,iVBORw=='
const PROFILE = '/api/auth/profile'
const AVATAR = '/api/auth/avatar'

const whoami = (avatar?: string): Whoami =>
  ({ kind: 'sso', email: 'ada@openathena.ai', admin: false, scopes: [], subject: { name: 'Ada', ...(avatar ? { avatar } : {}) } }) as Whoami

const input = () => screen.getByPlaceholderText('GitHub, Bluesky, or Mastodon profile, image URL, or website')

async function savedBody(calls: ReturnType<typeof stubFetch>) {
  await userEvent.click(screen.getByRole('button', { name: 'Save profile' }))
  await waitFor(() => expect(calls.filter(c => c.method === 'PUT').length).toBe(1))
  return calls.find(c => c.method === 'PUT')!.body
}

describe('ProfilePanel', () => {
  it('editing only the name sends no `avatar`', async () => {
    const calls = stubFetch({ [PROFILE]: { status: 200, body: {} } })
    renderWithQuery(<ProfilePanel whoami={whoami()} />)
    const name = screen.getByLabelText('Name')
    await userEvent.clear(name)
    await userEvent.type(name, 'Ada L')
    expect(await savedBody(calls)).toEqual({ name: 'Ada L' })
  })

  it('a failed lookup sends no `avatar`, so it neither removes a saved photo nor blocks the imported one', async () => {
    const calls = stubFetch({
      [AVATAR]: { status: 400, body: { error: 'invalid avatar', detail: 'no' } },
      [PROFILE]: { status: 200, body: {} },
    })
    renderWithQuery(<ProfilePanel whoami={whoami(FACE)} />)
    await userEvent.type(input(), 'https://www.linkedin.com/in/x')
    await screen.findByRole('alert')
    expect(await savedBody(calls)).toEqual({ name: 'Ada' })
  })

  it('emptying the text after a lookup goes back to keeping the current photo', async () => {
    const calls = stubFetch({ [AVATAR]: { status: 200, body: { avatar: null, source: 'github' } }, [PROFILE]: { status: 200, body: {} } })
    renderWithQuery(<ProfilePanel whoami={whoami(FACE)} />)
    await userEvent.type(input(), 'torvalds')
    await screen.findByText('No avatar found there')
    await userEvent.clear(input())
    expect(await savedBody(calls)).toEqual({ name: 'Ada' })
  })

  it('offers Clear for a saved photo, and that sends the removal', async () => {
    const calls = stubFetch({ [PROFILE]: { status: 200, body: {} } })
    renderWithQuery(<ProfilePanel whoami={whoami(FACE)} />)
    await userEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(screen.queryByRole('button', { name: 'Clear' })).toBe(null)
    expect(await savedBody(calls)).toEqual({ name: 'Ada', avatar: null })
  })

  it('offers no Clear when there is no photo to remove', () => {
    stubFetch({})
    renderWithQuery(<ProfilePanel whoami={whoami()} />)
    expect(screen.queryByRole('button', { name: 'Clear' })).toBe(null)
  })

  it('a lookup that finds nothing after Clear still sends the removal', async () => {
    const calls = stubFetch({ [AVATAR]: { status: 200, body: { avatar: null, source: 'github' } }, [PROFILE]: { status: 200, body: {} } })
    renderWithQuery(<ProfilePanel whoami={whoami(FACE)} />)
    await userEvent.click(screen.getByRole('button', { name: 'Clear' }))
    await userEvent.type(input(), 'torvalds')
    await screen.findByText('No avatar found there')
    expect(await savedBody(calls)).toEqual({ name: 'Ada', avatar: null })
  })
})
