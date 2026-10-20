import { useEffect, useRef, useState } from 'react'
import { Avatar } from './Avatar.js'
import { downscaleDataUri, downscaleImage } from '../client/image.js'

export { downscaleImage } from '../client/image.js'

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
