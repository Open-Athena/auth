/**
 * `downscaleImage` for a `data:` URI. Where the browser can't decode or
 * re-encode (no `createImageBitmap`, as in jsdom), the original passes through
 * and the server's storage cap is the backstop.
 */
export async function downscaleDataUri(uri: string, size: number): Promise<string> {
  const [head, b64 = ''] = uri.split(',', 2)
  const type = /^data:([^;,]+)/.exec(head ?? '')?.[1] ?? 'application/octet-stream'
  try {
    const blob = new Blob([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], { type })
    return await downscaleImage(blob, { size })
  } catch (e) {
    // An SVG must become pixels here: passed through, the write would refuse it.
    if (type === 'image/svg+xml') throw Object.assign(new Error("couldn't draw that SVG in this browser; upload an image instead"), { cause: e, svg: true })
    return uri
  }
}

/**
 * Center-crop an image file to a square and downscale it to at most `size`
 * pixels, in the browser, returning a `data:` URI. No server-side image codec
 * (or Cloudflare Images) needed: re-encoding here keeps uploads small enough to
 * inline, and drops EXIF (GPS included) on the way.
 *
 * An SVG (a site's icon, usually a logo) is drawn whole, fitted into a `size`
 * square, rather than cropped: it has no pixels of its own to keep. Drawn
 * through an `<img>`, it runs no script and loads nothing, so what comes out is
 * plain pixels — an SVG itself is never stored.
 *
 * WebP where the browser can encode it (keeps transparency); Safari can't, so
 * there it falls back to JPEG over white.
 */
export async function downscaleImage(
  file: Blob,
  { size = 256, quality = 0.85 }: { size?: number; quality?: number } = {},
): Promise<string> {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no 2d canvas')
  let draw: () => void
  let release = () => {}
  if (file.type === 'image/svg+xml') {
    const { img, width, height, revoke } = await loadSvg(file)
    release = revoke
    canvas.width = canvas.height = size
    const scale = size / Math.max(width, height)
    const [w, h] = [width * scale, height * scale]
    draw = () => ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h)
  } else {
    const bmp = await createImageBitmap(file)
    const side = Math.min(bmp.width, bmp.height)
    const out = Math.min(size, side)
    canvas.width = canvas.height = out
    draw = () => ctx.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, out, out)
  }
  try {
    draw()
    const webp = canvas.toDataURL('image/webp', quality)
    if (webp.startsWith('data:image/webp')) return webp
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    draw()
    return canvas.toDataURL('image/jpeg', quality)
  } finally {
    release()
  }
}

/**
 * Decode an SVG through an `<img>` (`createImageBitmap` won't take one), with
 * its aspect ratio from `viewBox` or `width`/`height`: an SVG declaring
 * neither reports a browser default (300×150 in Chrome, 0 in Firefox), so it's
 * taken as square.
 */
async function loadSvg(file: Blob): Promise<{ img: HTMLImageElement; width: number; height: number; revoke: () => void }> {
  const text = await file.text()
  const root = /<svg\b[^>]*>/i.exec(text)?.[0] ?? ''
  const attr = (name: string) => new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(root)?.[1]
  const box = attr('viewBox')?.trim().split(/[\s,]+/).map(Number)
  const px = (v?: string) => (v && /^\s*[\d.]+\s*(px)?\s*$/.test(v) ? Number.parseFloat(v) : 0)
  let [width, height] = box?.length === 4 && box[2]! > 0 && box[3]! > 0 ? [box[2]!, box[3]!] : [px(attr('width')), px(attr('height'))]
  if (!(width > 0 && height > 0)) [width, height] = [1, 1]
  const url = URL.createObjectURL(file)
  const img = new Image()
  img.src = url
  try {
    await img.decode()
  } catch (e) {
    URL.revokeObjectURL(url)
    throw e
  }
  return { img, width, height, revoke: () => URL.revokeObjectURL(url) }
}
