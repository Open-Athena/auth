import { describe, expect, it } from 'vitest'
import {
  MAX_INLINE_AVATAR_BYTES,
  githubAvatarUrl,
  gravatarUrl,
  isGithubHandle,
  isSafeAvatarUrl,
  resolveAvatar,
} from '../src/core/avatar.js'

/** A fetch that answers from a table, and records what it was asked for. */
function stubFetch(table: Record<string, { status?: number; type?: string; body?: Uint8Array }>) {
  const calls: string[] = []
  const fn = (async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    const hit = table[url]
    if (!hit) return new Response(null, { status: 404 })
    return new Response(hit.body ?? new Uint8Array([1, 2, 3]), {
      status: hit.status ?? 200,
      headers: { 'content-type': hit.type ?? 'image/png' },
    })
  }) as typeof globalThis.fetch
  return { fn, calls }
}

describe('gravatarUrl', () => {
  it('hashes the normalized address, and asks for a 404 rather than a generated face', async () => {
    // Same address, three spellings: Gravatar's key is the trimmed lowercase
    // form, so all three must produce one URL.
    // Hash checked independently: printf 'bob@example.com' | shasum -a 256
    const urls = await Promise.all(['bob@example.com', 'Bob@Example.COM', '  bob@example.com  '].map(e => gravatarUrl(e)))
    expect(urls).toEqual([
      'https://gravatar.com/avatar/5ff860bf1190596c7188ab851db691f0f3169c453936e9e1eba2f9a47f7a0018?s=128&d=404',
      urls[0],
      urls[0],
    ])
  })
})

describe('githubAvatarUrl / isGithubHandle', () => {
  it('accepts real handles and rejects anything that would escape the path', () => {
    const cases = ['torvalds', 'ryan-williams', 'a', 'a'.repeat(39), 'a'.repeat(40), '-lead', 'trail-', 'a--b', '../etc', 'a b']
    expect(cases.map(isGithubHandle)).toEqual([true, true, true, true, false, false, false, false, false, false])
  })

  it('builds the redirecting URL', () => {
    expect(githubAvatarUrl('torvalds', 64)).toBe('https://github.com/torvalds.png?size=64')
  })
})

describe('isSafeAvatarUrl', () => {
  it('takes https without credentials, and nothing else', () => {
    const cases = [
      'https://cdn.test/bob.png',
      'http://cdn.test/bob.png',
      'https://user:pw@cdn.test/bob.png',
      'javascript:alert(1)',
      'data:image/png;base64,AAAA',
      'not a url',
      `https://cdn.test/${'x'.repeat(2048)}`,
    ]
    expect(cases.map(isSafeAvatarUrl)).toEqual([true, false, false, false, false, false, false])
  })
})

describe('resolveAvatar', () => {
  it('prefers an explicit URL and does not probe it', async () => {
    const { fn, calls } = stubFetch({})
    expect(await resolveAvatar({ url: 'https://cdn.test/bob.png', email: 'bob@example.com' }, { fetch: fn })).toBe(
      'https://cdn.test/bob.png',
    )
    // A hotlink-protected host would fail a probe; the admin's assertion stands.
    expect(calls).toEqual([])
  })

  it('probes GitHub before trusting the handle', async () => {
    const { fn, calls } = stubFetch({ 'https://github.com/torvalds.png?size=128': {} })
    const [found, missing] = [
      await resolveAvatar({ github: 'torvalds' }, { fetch: fn }),
      await resolveAvatar({ github: 'nobody-here' }, { fetch: fn }),
    ]
    expect([found, missing]).toEqual(['https://github.com/torvalds.png?size=128', null])
    expect(calls).toEqual(['https://github.com/torvalds.png?size=128', 'https://github.com/nobody-here.png?size=128'])
  })

  it('reports "no avatar" as null rather than as a failure', async () => {
    const { fn } = stubFetch({})
    // Gravatar's `d=404` answer for an address with no avatar.
    expect(await resolveAvatar({ email: 'nobody@example.com' }, { fetch: fn })).toBe(null)
    expect(await resolveAvatar({}, { fetch: fn })).toBe(null)
  })

  it('refuses a malformed source instead of fetching something surprising', async () => {
    const { fn, calls } = stubFetch({})
    const results = [
      await resolveAvatar({ url: 'javascript:alert(1)' }, { fetch: fn }),
      await resolveAvatar({ github: '../../etc/passwd' }, { fetch: fn }),
    ]
    expect(results).toEqual([null, null])
    expect(calls).toEqual([])
  })

  describe('inline', () => {
    const png = 'https://github.com/torvalds.png?size=128'

    it('returns a data URI, so the recipient never calls the third party', async () => {
      const { fn } = stubFetch({ [png]: { body: new Uint8Array([137, 80, 78, 71]) } })
      expect(await resolveAvatar({ github: 'torvalds' }, { fetch: fn, inline: true })).toBe('data:image/png;base64,iVBORw==')
    })

    it('refuses a non-image, an SVG, and anything oversized', async () => {
      const cases = [
        { type: 'text/html' },
        // SVG is a script container; inlining one into an admin's page is not
        // the same kind of thing as inlining a PNG.
        { type: 'image/svg+xml' },
        { type: 'image/png', body: new Uint8Array(MAX_INLINE_AVATAR_BYTES + 1) },
        { type: 'image/png', body: new Uint8Array(0) },
      ]
      const results = []
      for (const hit of cases) {
        const { fn } = stubFetch({ [png]: hit })
        results.push(await resolveAvatar({ github: 'torvalds' }, { fetch: fn, inline: true }))
      }
      expect(results).toEqual([null, null, null, null])
    })
  })
})
