// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_WHOAMI_ENDPOINT, displayName, hasScope } from '../src/client/identity.js'
import type { GrantWhoami } from '../src/client/identity.js'
import { exchangeKeyParam, hasKeyParam } from '../src/client/exchange.js'
import { downscaleDataUri, downscaleImage } from '../src/client/image.js'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  window.history.replaceState({}, '', '/')
})

describe('framework-free identity helpers', () => {
  it('preserves label precedence and scope matching', () => {
    const grant: GrantWhoami = {
      kind: 'grant', id: 'g1', name: 'Board packet', subject: { name: 'Ann', email: 'subject@example.com' },
      email: 'link@example.com', scopes: ['reports'], admin: false, expiresAt: null,
    }
    expect(DEFAULT_WHOAMI_ENDPOINT).toBe('/api/auth/whoami')
    expect([
      displayName(grant),
      displayName({ ...grant, subject: {} }),
      displayName({ ...grant, name: null, subject: { email: 'subject@example.com' } }),
      displayName({ ...grant, name: null, subject: null }),
      displayName({ ...grant, name: null, subject: null, email: null }),
      displayName({ kind: 'sso', email: 'staff@example.com', admin: true, scopes: [], subject: { name: 'Staff' } }),
      displayName(null), displayName(undefined),
    ]).toEqual(['Ann', 'Board packet', 'subject@example.com', 'link@example.com', null, 'Staff', null, null])
    expect([
      hasScope(grant, 'reports'), hasScope(grant, 'report'),
      hasScope({ ...grant, scopes: ['*'] }, 'anything'), hasScope(null, 'reports'),
    ]).toEqual([true, false, true, false])
  })
})

describe('framework-free exchange helpers', () => {
  it('claims a custom token synchronously and exchanges only once', async () => {
    window.history.replaceState({}, '', '/slides?mode=read&t=SECRET#4')
    const request = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', request)
    expect([hasKeyParam(), hasKeyParam({ param: 't' })]).toEqual([false, true])
    const first = exchangeKeyParam({ param: 't', endpoint: '/exchange' })
    expect(window.location.pathname + window.location.search + window.location.hash).toBe('/slides?mode=read#4')
    expect(await Promise.all([first, exchangeKeyParam({ param: 't' })])).toEqual([true, false])
    expect(request.mock.calls).toEqual([['/exchange', {
      method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'SECRET' }),
    }]])
  })

  it.each(['http', 'network'])('strips the key even on %s failure', async failure => {
    window.history.replaceState({}, '', '/?key=SECRET#slide')
    vi.stubGlobal('fetch', failure === 'http'
      ? vi.fn().mockResolvedValue({ ok: false })
      : vi.fn().mockRejectedValue(new Error('offline')))
    expect(await exchangeKeyParam()).toBe(false)
    expect(window.location.search + window.location.hash).toBe('#slide')
  })

  it('imports without browser globals and returns false for SSR exchange', async () => {
    vi.stubGlobal('window', undefined)
    vi.stubGlobal('Image', undefined)
    vi.resetModules()
    const identity = await import('../src/client/identity.js')
    const exchange = await import('../src/client/exchange.js')
    const image = await import('../src/client/image.js')
    expect(identity.displayName(null)).toBe(null)
    expect(exchange.hasKeyParam()).toBe(false)
    expect(await exchange.exchangeKeyParam()).toBe(false)
    expect(typeof image.downscaleImage).toBe('function')
  })
})

describe('framework-free image helpers', () => {
  it('center-crops a raster image without upscaling', async () => {
    const bitmap = { width: 80, height: 40 }
    const decode = vi.fn().mockResolvedValue(bitmap)
    vi.stubGlobal('createImageBitmap', decode)
    const drawImage = vi.fn()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D)
    const encode = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/webp;base64,FACE')
    const file = new Blob(['raster'], { type: 'image/png' })
    expect(await downscaleImage(file)).toBe('data:image/webp;base64,FACE')
    expect(decode.mock.calls).toEqual([[file]])
    expect(drawImage.mock.calls).toEqual([[bitmap, 20, 0, 40, 40, 0, 0, 40, 40]])
    expect(encode.mock.calls).toEqual([['image/webp', 0.85]])
    const canvas = encode.mock.instances[0] as HTMLCanvasElement
    expect([canvas.width, canvas.height]).toEqual([40, 40])
  })

  it('passes through undecodable raster data but rejects undecodable SVG', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const uri = 'data:image/png;base64,AA=='
    expect(await downscaleDataUri(uri, 256)).toBe(uri)
    await expect(downscaleImage(new Blob())).rejects.toThrow('no 2d canvas')
    await expect(downscaleDataUri('data:image/svg+xml;base64,AA==', 256)).rejects.toMatchObject({
      message: "couldn't draw that SVG in this browser; upload an image instead", svg: true,
    })
  })
})
