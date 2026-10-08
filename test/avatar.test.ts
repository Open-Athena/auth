import { describe, expect, it } from 'vitest'
import {
  type AvatarRef,
  InvalidImageError,
  bytesToDataUri,
  fetchAvatar,
  githubAvatarUrl,
  gravatarUrl,
  isGithubHandle,
  isSafeAvatarUrl,
  isSvg,
  parseAvatarRef,
  validateUploadedImage,
} from '../src/core/avatar.js'

/** A real 1×1 PNG (transparent), so the sniffer reads a genuine IHDR. */
const PNG_1x1 = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='),
  c => c.charCodeAt(0),
)
/** A minimal GIF89a header declaring 1×1 — enough for the dimension sniff. */
const GIF_1x1 = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00])
const bytesOf = (s: string): Uint8Array => new TextEncoder().encode(s)

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

/** `parseAvatarRef`, with refusals as their message so one table covers both. */
const parse = (s: string) => {
  try {
    const r = parseAvatarRef(s)
    return r.kind === 'upload' ? { kind: r.kind, bytes: [...r.bytes] } : r
  } catch (e) {
    return { error: (e as Error).message }
  }
}

describe('parseAvatarRef', () => {
  it('recognizes each network by URL or handle', () => {
    expect(
      [
        'torvalds',
        '@torvalds',
        'https://github.com/torvalds',
        'https://github.com/torvalds/linux',
        'https://github.com/torvalds.png',
        'alice.bsky.social',
        'https://bsky.app/profile/Alice.bsky.social',
        'https://bsky.app/profile/did:plc:abcdefghijklmnopqrstuvwx',
        '@Gargron@mastodon.social',
        'https://mastodon.social/@Gargron',
        'https://media.licdn.com/dms/image/v2/X/profile-displayphoto-shrink_200_200/0?e=1&t=sig',
        'data:image/png;base64,iVBORw==',
      ].map(parse),
    ).toEqual([
      { kind: 'github', handle: 'torvalds' },
      { kind: 'github', handle: 'torvalds' },
      { kind: 'github', handle: 'torvalds' },
      { kind: 'github', handle: 'torvalds' },
      { kind: 'github', handle: 'torvalds' },
      { kind: 'bluesky', actor: 'alice.bsky.social' },
      { kind: 'bluesky', actor: 'alice.bsky.social' },
      { kind: 'bluesky', actor: 'did:plc:abcdefghijklmnopqrstuvwx' },
      { kind: 'mastodon', user: 'Gargron', instance: 'mastodon.social' },
      { kind: 'mastodon', user: 'Gargron', instance: 'mastodon.social' },
      // A LinkedIn *image* address is fine — it's the profile page that isn't.
      { kind: 'url', url: 'https://media.licdn.com/dms/image/v2/X/profile-displayphoto-shrink_200_200/0?e=1&t=sig' },
      { kind: 'upload', bytes: [137, 80, 78, 71] },
    ])
  })

  it('reads a URL pasted without its https://, as copied from an address bar', () => {
    expect(
      [
        'github.com/loomhq',
        'www.github.com/loomhq',
        'bsky.app/profile/alice.bsky.social',
        'mastodon.social/@Gargron',
        'cdn.test/faces/bob.png',
        'www.linkedin.com/in/someone',
        'http://github.com/loomhq',
      ].map(parse),
    ).toEqual([
      { kind: 'github', handle: 'loomhq' },
      { kind: 'github', handle: 'loomhq' },
      { kind: 'bluesky', actor: 'alice.bsky.social' },
      { kind: 'mastodon', user: 'Gargron', instance: 'mastodon.social' },
      { kind: 'url', url: 'https://cdn.test/faces/bob.png' },
      { error: 'LinkedIn has no public way to fetch a profile photo; open it, copy the image address (or save it and upload), and use that' },
      // An explicit http: is still refused, not upgraded.
      { error: 'only https: URLs are fetched' },
    ])
  })

  it('refuses, by name, the networks with no public way to get a face', () => {
    const fix = 'has no public way to fetch a profile photo; open it, copy the image address (or save it and upload), and use that'
    expect(
      ['https://www.linkedin.com/in/someone/', 'https://x.com/someone', 'https://twitter.com/someone', 'https://www.facebook.com/someone'].map(parse),
    ).toEqual([
      { error: `LinkedIn ${fix}` },
      { error: `X ${fix}` },
      { error: `X ${fix}` },
      { error: `Facebook ${fix}` },
    ])
  })

  it('refuses anything that would fetch something surprising', () => {
    expect(
      [
        '',
        'http://cdn.test/a.png',
        'javascript:alert(1)',
        'https://u:p@cdn.test/a.png',
        'data:text/html,<b>hi</b>',
        '../etc',
        'https://github.com/settings',
        '@bad!user@mastodon.social',
      ].map(parse),
    ).toEqual([
      { error: 'empty avatar reference' },
      { error: 'only https: URLs are fetched' },
      { error: 'only https: URLs are fetched' },
      { error: 'URLs with credentials are refused' },
      { error: 'only base64 data: URIs are accepted' },
      { error: 'not a profile URL, handle, or image URL: ../etc' },
      { error: 'a GitHub URL should be a profile: github.com/<handle>' },
      { error: 'not a Mastodon address: @bad!user@mastodon.social' },
    ])
  })
})

/** A fetch that answers from a table of images and JSON, recording every URL. */
function stubNet(table: Record<string, { status?: number; type?: string; body?: Uint8Array | string; json?: unknown }>) {
  const calls: string[] = []
  const fn = (async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    const hit = table[url]
    if (!hit) return new Response(null, { status: 404 })
    if (hit.json !== undefined) {
      return new Response(JSON.stringify(hit.json), { status: hit.status ?? 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(hit.body ?? PNG_1x1, { status: hit.status ?? 200, headers: { 'content-type': hit.type ?? 'image/png' } })
  }) as typeof globalThis.fetch
  return { fn, calls }
}

const PNG = { type: 'image/png', bytes: PNG_1x1 }
/** `fetchAvatar`, with failures as their message. */
const fetched = async (ref: AvatarRef, net: ReturnType<typeof stubNet>, maxBytes?: number) => {
  try {
    return await fetchAvatar(ref, { fetch: net.fn, ...(maxBytes ? { maxBytes } : {}) })
  } catch (e) {
    return { error: (e as Error).message }
  }
}

describe('fetchAvatar', () => {
  const BSKY_API = 'https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=alice.bsky.social'
  const MASTO_API = 'https://mastodon.social/api/v1/accounts/lookup?acct=Gargron'

  it('copies a GitHub face, and reports a missing handle as null', async () => {
    const net = stubNet({ 'https://github.com/torvalds.png?size=128': {} })
    expect([
      await fetched({ kind: 'github', handle: 'torvalds' }, net),
      await fetched({ kind: 'github', handle: 'nobody-here' }, net),
    ]).toEqual([PNG, null])
    expect(net.calls).toEqual(['https://github.com/torvalds.png?size=128', 'https://github.com/nobody-here.png?size=128'])
  })

  it('treats a Gravatar 404 as "no avatar", not a failure', async () => {
    expect(await fetched({ kind: 'gravatar', email: 'nobody@example.com' }, stubNet({}))).toBe(null)
  })

  it('looks a Bluesky handle up, then fetches the thumbnail preset rather than the original', async () => {
    const net = stubNet({
      [BSKY_API]: { json: { handle: 'alice.bsky.social', avatar: 'https://cdn.bsky.app/img/avatar/plain/did:plc:x/bafk@jpeg' } },
      'https://cdn.bsky.app/img/avatar_thumbnail/plain/did:plc:x/bafk@jpeg': {},
    })
    expect(await fetched({ kind: 'bluesky', actor: 'alice.bsky.social' }, net)).toEqual(PNG)
    expect(net.calls).toEqual([BSKY_API, 'https://cdn.bsky.app/img/avatar_thumbnail/plain/did:plc:x/bafk@jpeg'])
  })

  it('distinguishes a Bluesky profile with no picture from no profile at all', async () => {
    const actor = { kind: 'bluesky', actor: 'alice.bsky.social' } as const
    expect([
      await fetched(actor, stubNet({ [BSKY_API]: { json: { handle: 'alice.bsky.social' } } })),
      await fetched(actor, stubNet({ [BSKY_API]: { status: 400, json: { error: 'InvalidRequest' } } })),
    ]).toEqual([null, { error: 'no Bluesky profile alice.bsky.social' }])
  })

  it("looks a Mastodon account up on its own instance, and ignores the instance's stock image", async () => {
    const ref = { kind: 'mastodon', user: 'Gargron', instance: 'mastodon.social' } as const
    const real = stubNet({
      [MASTO_API]: { json: { avatar_static: 'https://files.mastodon.social/accounts/avatars/000/000/001/original/a.png' } },
      'https://files.mastodon.social/accounts/avatars/000/000/001/original/a.png': {},
    })
    const stock = stubNet({ [MASTO_API]: { json: { avatar_static: 'https://mastodon.social/avatars/original/missing.png' } } })
    expect([await fetched(ref, real), await fetched(ref, stock)]).toEqual([PNG, null])
    expect(stock.calls).toEqual([MASTO_API])
  })

  it('refuses a page, an SVG, an oversized image, and a failed fetch, saying which', async () => {
    const url = 'https://cdn.test/face'
    const ref = { kind: 'url', url } as const
    expect([
      await fetched(ref, stubNet({ [url]: { type: 'text/html', body: '<html>' } })),
      // SVG is a script container; sniffing (not the header) is what refuses it.
      await fetched(ref, stubNet({ [url]: { type: 'image/png', body: '<svg xmlns="http://www.w3.org/2000/svg"/>' } })),
      await fetched(ref, stubNet({ [url]: { body: new Uint8Array(70 * 1024) } })),
      await fetched(ref, stubNet({ [url]: { status: 403 } })),
      await fetched(ref, stubNet({})),
    ]).toEqual([
      { error: 'cdn.test is a web page with no usable icon; copy an image address instead (or save one and upload)' },
      { error: 'not a supported image (png, jpeg, webp, or gif)' },
      { error: 'image is 70 KB, over the 64 KB cap; save it and upload instead (uploads are downscaled)' },
      { error: 'fetching the image failed (HTTP 403)' },
      { error: 'fetching the image failed (HTTP 404)' },
    ])
  })

  describe('a web page instead of an image: its icon', () => {
    const page = (head: string) => ({ type: 'text/html; charset=utf-8', body: `<!doctype html><html><head>${head}</head><body>…</body></html>` })
    const SITE = { ...PNG, source: 'site' }

    it('takes the apple-touch-icon over a small favicon, resolving a relative href', async () => {
      const net = stubNet({
        'https://loom.test/': page('<link rel="icon" href="/favicon-32.png"><link rel=apple-touch-icon href="img/touch.png">'),
        'https://loom.test/img/touch.png': {},
      })
      expect(await fetched({ kind: 'url', url: 'https://loom.test/' }, net)).toEqual(SITE)
      expect(net.calls).toEqual(['https://loom.test/', 'https://loom.test/img/touch.png'])
    })

    it('ranks rel=icon by size, skipping SVG, and falls through a link that 404s', async () => {
      const net = stubNet({
        'https://loom.test/': page(
          `<link rel="icon" type="image/svg+xml" href="/i.svg"><link rel="icon" sizes="32x32" href="/i32.png">` +
            `<link rel='icon' sizes='192x192' href='https://cdn.loom.test/i192.png'><link rel="shortcut icon" sizes="512x512" href="/gone.png">`,
        ),
        'https://cdn.loom.test/i192.png': {},
      })
      expect(await fetched({ kind: 'url', url: 'https://loom.test/' }, net)).toEqual(SITE)
      expect(net.calls).toEqual(['https://loom.test/', 'https://loom.test/gone.png', 'https://cdn.loom.test/i192.png'])
    })

    it('with no icon links, tries /apple-touch-icon.png, then the PNG inside /favicon.ico', async () => {
      const ico = new Uint8Array(22 + PNG_1x1.length)
      ico.set([0, 0, 1, 0, 1, 0, 1, 1, 0, 0, 1, 0, 32, 0])
      new DataView(ico.buffer).setUint32(14, PNG_1x1.length, true)
      new DataView(ico.buffer).setUint32(18, 22, true)
      ico.set(PNG_1x1, 22)
      const net = stubNet({ 'https://loom.test/': page('<title>Loom</title>'), 'https://loom.test/favicon.ico': { type: 'image/x-icon', body: ico } })
      expect(await fetched({ kind: 'url', url: 'https://loom.test/' }, net)).toEqual(SITE)
      expect(net.calls).toEqual(['https://loom.test/', 'https://loom.test/apple-touch-icon.png', 'https://loom.test/favicon.ico'])
    })

    it('passes over an SVG icon for storage, saying so; a preview (`allowSvg`) takes it', async () => {
      const svg = '<?xml version="1.0"?>\n<!-- logo --><svg xmlns="http://www.w3.org/2000/svg"/>'
      const table = {
        'https://loom.test/': page('<link rel="icon" sizes="16x16" href="/f16.png"><link rel="icon" href="/logo.svg">'),
        'https://loom.test/logo.svg': { type: 'image/svg+xml', body: svg },
      }
      const ref = { kind: 'url', url: 'https://loom.test/' } as const
      const stored = await fetched(ref, stubNet(table))
      const net = stubNet(table)
      const preview = await fetchAvatar(ref, { fetch: net.fn, allowSvg: true })
      expect([stored, preview]).toEqual([
        { error: "loom.test's icon is an SVG, which only the face picker in a browser can convert; pick it there, or upload an image" },
        { type: 'image/svg+xml', bytes: bytesOf(svg), source: 'site' },
      ])
      // The SVG outranks the 16px favicon.
      expect(net.calls).toEqual(['https://loom.test/', 'https://loom.test/logo.svg'])
    })

    it('reads a bare domain that is no Bluesky handle as a website', async () => {
      const net = stubNet({
        'https://loom.test/': page('<link rel="apple-touch-icon" href="/t.png">'),
        'https://loom.test/t.png': {},
      })
      expect(await fetched(parseAvatarRef('loom.test'), net)).toEqual(SITE)
      expect(net.calls).toEqual([
        'https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=loom.test',
        'https://loom.test/',
        'https://loom.test/t.png',
      ])
    })
  })

  it('validates upload bytes without touching the network', async () => {
    const net = stubNet({})
    expect(await fetched({ kind: 'upload', bytes: PNG_1x1 }, net)).toEqual(PNG)
    expect(net.calls).toEqual([])
  })
})

describe('isSvg', () => {
  it('sees an SVG past a BOM, XML declaration, comments and doctype, and nothing else', () => {
    expect(
      [
        '<svg xmlns="http://www.w3.org/2000/svg"/>',
        '\uFEFF<?xml version="1.0"?>\n<!-- a -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x">\n<svg>',
        '<html><svg>',
        '<svgx>',
        'svg',
      ].map(s => isSvg(bytesOf(s))),
    ).toEqual([true, true, false, false, false])
  })
})

describe('validateUploadedImage', () => {
  it('accepts a real PNG and reports its sniffed type, bytes untouched', () => {
    expect(validateUploadedImage(PNG_1x1)).toEqual({ type: 'image/png', bytes: PNG_1x1 })
  })

  it('accepts a GIF by its header, not a caller-supplied content type', () => {
    expect(validateUploadedImage(GIF_1x1)).toEqual({ type: 'image/gif', bytes: GIF_1x1 })
  })

  it('throws on an SVG — a script container has no business as an avatar', () => {
    expect(() => validateUploadedImage(bytesOf('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'))).toThrow(
      InvalidImageError,
    )
  })

  it('throws on a text file even when the caller would label it image/png', () => {
    // The header is never consulted; only the magic bytes are. "hello" is not a
    // PNG no matter what content type rode in with it.
    expect(() => validateUploadedImage(bytesOf('hello, definitely not a png'))).toThrow(InvalidImageError)
  })

  it('throws when over the byte cap', () => {
    expect(() => validateUploadedImage(PNG_1x1, { maxBytes: 10 })).toThrow(InvalidImageError)
  })

  it('throws on empty bytes', () => {
    expect(() => validateUploadedImage(new Uint8Array(0))).toThrow(InvalidImageError)
  })
})

describe('bytesToDataUri', () => {
  it('round-trips bytes through a standard-base64 data URI', () => {
    const uri = bytesToDataUri('image/png', new Uint8Array([1, 2, 3, 4]))
    expect(uri).toBe(`data:image/png;base64,${btoa('\x01\x02\x03\x04')}`)
  })
})
