import { useEffect, useRef, useState } from 'react'
import { Avatar } from './Avatar.js'

/** Where the current preview came from — mirrors the server's `AvatarRefKind`. */
export type AvatarFieldSource = 'github' | 'bluesky' | 'mastodon' | 'gravatar' | 'url' | 'site' | 'upload'

type Status =
  | { kind: 'idle' }
  | { kind: 'looking' }
  | { kind: 'found'; source: AvatarFieldSource }
  /** The lookup worked; there's just no face there (initials it is). */
  | { kind: 'none'; source: AvatarFieldSource }
  | { kind: 'error'; detail: string }

export interface AvatarFieldProps {
  /** `POST` preview endpoint (`authRoutes`' `<basePath>/avatar`). Default `/api/auth/avatar`. */
  endpoint?: string
  /**
   * The face to store, as a `data:` URI the server re-validates and copies, or
   * null for none (initials). Controlled.
   */
  value: string | null
  onChange: (value: string | null) => void
  /** Whose face: with nothing typed, their Gravatar is previewed (see `autoGravatar`). */
  email?: string | null
  /** Default true. False offers a "Use Gravatar" button instead of looking it up unprompted. */
  autoGravatar?: boolean
  /** Initials for the preview when there's no image. */
  name?: string | null
  /** Show the preview avatar beside the input. Default true. */
  preview?: boolean
  /** Preview pixels. Default 48. */
  size?: number
  /** Every face (uploaded or looked up) is center-cropped and downscaled to this many square pixels before it's sent. Default 256. */
  uploadSize?: number
  id?: string
  classNames?: Partial<Record<'field' | 'row' | 'input' | 'button' | 'preview' | 'hint', string>>
  labels?: Partial<
    Record<'placeholder' | 'upload' | 'clear' | 'gravatar' | 'looking' | 'none' | AvatarFieldSource, string>
  >
}

const SOURCE_LABELS: Record<AvatarFieldSource, string> = {
  github: 'From GitHub',
  bluesky: 'From Bluesky',
  mastodon: 'From Mastodon',
  gravatar: 'From Gravatar',
  url: 'From image URL',
  site: "From the site's icon",
  upload: 'Uploaded',
}

const EMAILISH = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * One field for a person's face: paste a GitHub / Bluesky / Mastodon profile
 * (or handle), or an image address, or upload a file — or leave it empty and
 * get their Gravatar. Every option previews *before* anything is saved, via the
 * server, which fetches and sniffs the image; what comes back is a `data:` URI,
 * and that copy is what gets stored — never a link to the third party.
 *
 * LinkedIn, X and Facebook have no public way to fetch a profile photo, so a
 * pasted profile URL from them is refused with a pointer to "copy image
 * address" or an upload. Every face is downscaled in the browser before it's
 * stored (see `downscaleImage`), which also re-encodes away EXIF — so no
 * server-side image codec or resizing service is needed.
 */
export function AvatarField({
  endpoint = '/api/auth/avatar',
  value,
  onChange,
  email,
  autoGravatar = true,
  name,
  preview = true,
  size = 48,
  uploadSize = 256,
  id = 'oa-avatar-ref',
  classNames = {},
  labels = {},
}: AvatarFieldProps) {
  const [text, setText] = useState('')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  // Set by an upload, a clear, or an explicit Gravatar ask: the text/email
  // effect must not then overwrite the choice with an automatic lookup.
  const [pinned, setPinned] = useState(false)
  const [gravatarAsked, setGravatarAsked] = useState(false)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  // Whether this field has reported anything yet: until it has, an empty field
  // is "untouched", not "cleared" — `ProfilePanel` reads that as "keep".
  const emitted = useRef(false)
  const emit = (v: string | null) => {
    emitted.current = true
    onChangeRef.current(v)
  }
  const fileRef = useRef<HTMLInputElement>(null)

  const trimmedEmail = email?.trim() ?? ''
  const wantGravatar = !text.trim() && EMAILISH.test(trimmedEmail) && (autoGravatar || gravatarAsked)

  useEffect(() => {
    if (pinned) return
    const ref = text.trim()
    if (!ref && !wantGravatar) {
      setStatus({ kind: 'idle' })
      if (emitted.current) emit(null)
      return
    }
    const ctl = new AbortController()
    // Debounced: a lookup per keystroke would hammer the server and the provider.
    const timer = setTimeout(async () => {
      setStatus({ kind: 'looking' })
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(ref ? { ref } : { email: trimmedEmail }),
          signal: ctl.signal,
        })
        const b = (await res.json().catch(() => ({}))) as {
          avatar?: string | null
          source?: AvatarFieldSource
          detail?: string
          error?: string
        }
        if (!res.ok) {
          setStatus({ kind: 'error', detail: b.detail ?? b.error ?? `lookup failed (HTTP ${res.status})` })
          emit(null)
          return
        }
        const source = b.source ?? 'url'
        // The server returns what the source serves (up to its preview cap);
        // the copy that gets stored is this downscale.
        const face = b.avatar ? await downscaleDataUri(b.avatar, uploadSize) : null
        if (ctl.signal.aborted) return
        setStatus(face ? { kind: 'found', source } : { kind: 'none', source })
        emit(face)
      } catch (e) {
        if ((e as Error).name === 'AbortError') return
        setStatus({ kind: 'error', detail: (e as { svg?: boolean }).svg ? (e as Error).message : 'lookup failed' })
        emit(null)
      }
    }, 400)
    return () => {
      clearTimeout(timer)
      ctl.abort()
    }
  }, [text, wantGravatar, trimmedEmail, endpoint, pinned, uploadSize])

  async function upload(file: File | undefined) {
    if (!file) return
    setPinned(true)
    setText('')
    try {
      emit(await downscaleImage(file, { size: uploadSize }))
      setStatus({ kind: 'found', source: 'upload' })
    } catch {
      emit(null)
      setStatus({ kind: 'error', detail: "couldn't read that file as an image" })
    }
    if (fileRef.current) fileRef.current.value = ''
  }

  function clear() {
    setPinned(true)
    setText('')
    setGravatarAsked(false)
    setStatus({ kind: 'idle' })
    emit(null)
  }

  const hint =
    status.kind === 'looking'
      ? (labels.looking ?? 'Looking up…')
      : status.kind === 'found'
        ? (labels[status.source] ?? SOURCE_LABELS[status.source])
        : status.kind === 'none'
          ? // No Gravatar is the common case, not news; only say so when asked.
            status.source === 'gravatar' && autoGravatar
            ? null
            : (labels.none ?? 'No avatar found there')
          : status.kind === 'error'
            ? status.detail
            : null

  return (
    <div className={classNames.field}>
      <div className={classNames.row} style={{ display: 'flex', alignItems: 'center', gap: '0.5em' }}>
        {preview && (
          <span className={classNames.preview}>
            <Avatar src={value} name={name} size={size} />
          </span>
        )}
        <input
          className={classNames.input}
          id={id}
          type="text"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder={labels.placeholder ?? 'GitHub, Bluesky, or Mastodon profile, image URL, or website'}
          value={text}
          onChange={e => {
            setPinned(false)
            setText(e.target.value)
          }}
        />
        <button className={classNames.button} type="button" onClick={() => fileRef.current?.click()}>
          {labels.upload ?? 'Upload…'}
        </button>
        {!autoGravatar && EMAILISH.test(trimmedEmail) && !text.trim() && (
          <button
            className={classNames.button}
            type="button"
            onClick={() => {
              setPinned(false)
              setGravatarAsked(true)
            }}
          >
            {labels.gravatar ?? 'Use Gravatar'}
          </button>
        )}
        {(value || text) && (
          <button className={classNames.button} type="button" onClick={clear}>
            {labels.clear ?? 'Clear'}
          </button>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
          hidden
          onChange={e => void upload(e.target.files?.[0])}
        />
      </div>
      {hint && (
        <span className={classNames.hint} role={status.kind === 'error' ? 'alert' : undefined}>
          {hint}
        </span>
      )}
    </div>
  )
}

/**
 * `downscaleImage` for a `data:` URI. Where the browser can't decode or
 * re-encode (no `createImageBitmap`, as in jsdom), the original passes through
 * and the server's storage cap is the backstop.
 */
async function downscaleDataUri(uri: string, size: number): Promise<string> {
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
