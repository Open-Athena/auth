import { type FormEvent, useState } from 'react'
import { Avatar } from './Avatar.js'
import { useForgetWhoami } from './useWhoami.js'
import { type Whoami, displayName } from './types.js'

/** Where the avatar comes from on save. `keep` leaves the current one untouched. */
export type AvatarChoice = 'keep' | 'upload' | 'url' | 'github' | 'gravatar' | 'clear'

type PanelState = 'idle' | 'saving' | 'saved' | 'error'

export interface ProfilePanelProps {
  /** Default `/api/auth/profile`. */
  endpoint?: string
  /** The current identity, to seed the name fields and preview the avatar. */
  whoami?: Whoami | null
  /** Called after a successful save (the whoami cache is refetched regardless). */
  onSaved?: () => void
  classNames?: Partial<
    Record<'form' | 'field' | 'label' | 'input' | 'select' | 'button' | 'message' | 'preview', string>
  >
  labels?: Partial<
    Record<'name' | 'avatar' | 'save' | 'saving' | 'saved' | keyof Record<AvatarChoice, string>, string>
  >
}

const AVATAR_LABELS: Record<AvatarChoice, string> = {
  keep: 'Keep current',
  upload: 'Upload a file',
  url: 'From a URL',
  github: 'From GitHub',
  gravatar: 'From Gravatar (my email)',
  clear: 'Clear (use initials)',
}

const asSubject = (whoami: Whoami | null | undefined): { name?: string } =>
  (whoami as { subject?: { name?: string } } | null | undefined)?.subject ?? {}

/**
 * Let a signed-in principal set their own display name and face. Unstyled, like
 * the rest of `react/`: every visible string and class is a prop.
 *
 * The avatar is always copied server-side (`PUT /api/profile` calls
 * `resolveAvatar`/`validateUploadedImage`), so nothing here ever persists a live
 * third-party URL — a paste of an image URL is fetched once and inlined, not
 * rendered from its origin on every view.
 */
export function ProfilePanel({
  endpoint = '/api/auth/profile',
  whoami,
  onSaved,
  classNames = {},
  labels = {},
}: ProfilePanelProps) {
  const seed = asSubject(whoami)
  const forget = useForgetWhoami()
  const [name, setName] = useState(seed.name ?? '')
  const [choice, setChoice] = useState<AvatarChoice>('keep')
  const [url, setUrl] = useState('')
  const [github, setGithub] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [state, setState] = useState<PanelState>('idle')
  const [error, setError] = useState<string | null>(null)

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (state === 'saving') return
    setState('saving')
    setError(null)
    try {
      const res =
        choice === 'upload' && file
          ? await fetch(endpoint, { method: 'PUT', credentials: 'include', body: uploadBody(name, file) })
          : await fetch(endpoint, {
              method: 'PUT',
              credentials: 'include',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ name, ...avatarField(choice, url, github) }),
            })
      if (res.ok) {
        setState('saved')
        forget() // refetch whoami so the chip picks up the new name/face
        onSaved?.()
      } else {
        const b = (await res.json().catch(() => ({}))) as { detail?: string; error?: string }
        setState('error')
        setError(b.detail ?? b.error ?? 'Could not save your profile.')
      }
    } catch {
      setState('error')
      setError('Could not save your profile.')
    }
  }

  const label = (k: keyof typeof AVATAR_LABELS): string => labels[k] ?? AVATAR_LABELS[k]

  return (
    <form className={classNames.form} onSubmit={save}>
      <div className={classNames.preview}>
        <Avatar whoami={whoami} name={name.trim() || displayName(whoami)} size={64} />
      </div>

      <div className={classNames.field}>
        <label className={classNames.label} htmlFor="oa-profile-name">
          {labels.name ?? 'Name'}
        </label>
        <input
          className={classNames.input}
          id="oa-profile-name"
          type="text"
          autoComplete="name"
          value={name}
          onChange={e => setName(e.target.value)}
        />
      </div>

      <div className={classNames.field}>
        <label className={classNames.label} htmlFor="oa-profile-avatar">
          {labels.avatar ?? 'Avatar'}
        </label>
        <select
          className={classNames.select}
          id="oa-profile-avatar"
          value={choice}
          onChange={e => setChoice(e.target.value as AvatarChoice)}
        >
          {(Object.keys(AVATAR_LABELS) as AvatarChoice[]).map(k => (
            <option key={k} value={k}>
              {label(k)}
            </option>
          ))}
        </select>
      </div>

      {choice === 'upload' && (
        <div className={classNames.field}>
          <input
            className={classNames.input}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            onChange={e => setFile(e.target.files?.[0] ?? null)}
          />
        </div>
      )}
      {choice === 'url' && (
        <div className={classNames.field}>
          <input
            className={classNames.input}
            type="url"
            placeholder="https://…"
            value={url}
            onChange={e => setUrl(e.target.value)}
          />
        </div>
      )}
      {choice === 'github' && (
        <div className={classNames.field}>
          <input
            className={classNames.input}
            type="text"
            placeholder="github-handle"
            value={github}
            onChange={e => setGithub(e.target.value)}
          />
        </div>
      )}

      <button className={classNames.button} type="submit" disabled={state === 'saving'}>
        {state === 'saving' ? (labels.saving ?? 'Saving…') : (labels.save ?? 'Save profile')}
      </button>

      {state === 'saved' && <p className={classNames.message}>{labels.saved ?? 'Saved.'}</p>}
      {state === 'error' && error && <p className={classNames.message}>{error}</p>}
    </form>
  )
}

function avatarField(choice: AvatarChoice, url: string, github: string): { avatar?: unknown } {
  switch (choice) {
    case 'url':
      return { avatar: { url } }
    case 'github':
      return { avatar: { github } }
    case 'gravatar':
      return { avatar: { gravatar: true } }
    case 'clear':
      return { avatar: null }
    default:
      return {} // 'keep' (and 'upload' handled via multipart) leave it unchanged
  }
}

function uploadBody(name: string, file: File): FormData {
  const fd = new FormData()
  fd.set('name', name)
  fd.set('avatar', file)
  return fd
}
