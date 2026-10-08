// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { AvatarField } from '../../src/react/AvatarField.js'
import { stubFetch } from './helpers.js'

const realFetch = globalThis.fetch
afterEach(() => {
  cleanup()
  globalThis.fetch = realFetch
})

const FACE = 'data:image/png;base64,iVBORw=='

/** A controlled field that records every value it reports. */
function Harness({ email, seen }: { email?: string; seen: (string | null)[] }) {
  const [value, setValue] = useState<string | null>(null)
  return (
    <AvatarField
      value={value}
      email={email ?? null}
      onChange={v => {
        seen.push(v)
        setValue(v)
      }}
    />
  )
}

const input = () => screen.getByPlaceholderText('GitHub, Bluesky, or Mastodon profile, image URL, or website')

describe('AvatarField', () => {
  it('previews a pasted profile through the server, and reports the copy it returns', async () => {
    const calls = stubFetch({ '/api/auth/avatar': { status: 200, body: { avatar: FACE, source: 'github' } } })
    const seen: (string | null)[] = []
    render(<Harness seen={seen} />)
    await userEvent.type(input(), 'torvalds')

    await screen.findByText('From GitHub')
    // Debounced: one lookup for the whole handle, not one per keystroke.
    expect(calls).toEqual([{ url: '/api/auth/avatar', method: 'POST', body: { ref: 'torvalds' } }])
    expect(seen).toEqual([FACE])
    expect(screen.getByRole('presentation').getAttribute('src')).toBe(FACE)
  })

  it("shows the server's reason when a source can't be copied", async () => {
    const detail = 'LinkedIn has no public way to fetch a profile photo; open it, copy the image address (or save it and upload), and use that'
    stubFetch({ '/api/auth/avatar': { status: 400, body: { error: 'invalid avatar', detail } } })
    const seen: (string | null)[] = []
    render(<Harness seen={seen} />)
    await userEvent.type(input(), 'https://www.linkedin.com/in/x')

    expect((await screen.findByRole('alert')).textContent).toBe(detail)
    expect(seen).toEqual([null])
  })

  it("looks the recipient's Gravatar up when nothing is typed, and says nothing when there isn't one", async () => {
    const calls = stubFetch({ '/api/auth/avatar': { status: 200, body: { avatar: null, source: 'gravatar' } } })
    const seen: (string | null)[] = []
    render(<Harness email="ann@example.com" seen={seen} />)

    await waitFor(() => expect(seen).toEqual([null]))
    expect(calls).toEqual([{ url: '/api/auth/avatar', method: 'POST', body: { email: 'ann@example.com' } }])
    expect([screen.queryByRole('alert'), screen.queryByText('No avatar found there')]).toEqual([null, null])
  })

  it('reports nothing until touched, so "untouched" stays distinguishable from "cleared"', async () => {
    const calls = stubFetch({})
    const seen: (string | null)[] = []
    render(<Harness seen={seen} />)
    await new Promise(r => setTimeout(r, 450))
    expect([seen, calls]).toEqual([[], []])
  })
})
