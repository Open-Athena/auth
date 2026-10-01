import { type FormEvent, useState } from 'react'
import { Avatar } from './Avatar.js'
import { AvatarField, type AvatarFieldProps } from './AvatarField.js'
import { useForgetWhoami } from './useWhoami.js'
import { type Whoami, displayName } from './types.js'

type PanelState = 'idle' | 'saving' | 'saved' | 'error'

export interface ProfilePanelProps {
  /** Default `/api/auth/profile`. */
  endpoint?: string
  /** The avatar preview endpoint. Default: `endpoint` with `/profile` swapped for `/avatar`. */
  avatarEndpoint?: string
  /** The current identity, to seed the name field and preview the avatar. */
  whoami?: Whoami | null
  /** Called after a successful save (the whoami cache is refetched regardless). */
  onSaved?: () => void
  classNames?: Partial<Record<'form' | 'field' | 'label' | 'input' | 'button' | 'message' | 'preview', string>> & {
    avatar?: AvatarFieldProps['classNames']
  }
  labels?: Partial<Record<'name' | 'avatar' | 'save' | 'saving' | 'saved', string>> & {
    avatarField?: AvatarFieldProps['labels']
  }
}

const asSubject = (whoami: Whoami | null | undefined): { name?: string; avatar?: string } =>
  (whoami as { subject?: { name?: string; avatar?: string } } | null | undefined)?.subject ?? {}

/**
 * Let a signed-in principal set their own display name and face. Unstyled, like
 * the rest of `react/`: every visible string and class is a prop.
 *
 * The face comes from `<AvatarField>` (a profile, an image address, an upload,
 * or Gravatar on request), and is copied server-side on save — nothing here
 * ever persists a live third-party URL.
 */
export function ProfilePanel({
  endpoint = '/api/auth/profile',
  avatarEndpoint = endpoint.replace(/\/profile$/, '/avatar'),
  whoami,
  onSaved,
  classNames = {},
  labels = {},
}: ProfilePanelProps) {
  const seed = asSubject(whoami)
  const forget = useForgetWhoami()
  const [name, setName] = useState(seed.name ?? '')
  // `undefined` = keep the current face; `null` = clear it; a `data:` URI = replace.
  const [avatar, setAvatar] = useState<string | null | undefined>(undefined)
  const [state, setState] = useState<PanelState>('idle')
  const [error, setError] = useState<string | null>(null)

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (state === 'saving') return
    setState('saving')
    setError(null)
    try {
      const res = await fetch(endpoint, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, ...(avatar === undefined ? {} : { avatar: avatar === null ? null : { ref: avatar } }) }),
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

  return (
    <form className={classNames.form} onSubmit={save}>
      <div className={classNames.preview}>
        <Avatar
          src={avatar === undefined ? (seed.avatar ?? null) : avatar}
          name={name.trim() || displayName(whoami)}
          size={64}
        />
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
        <AvatarField
          id="oa-profile-avatar"
          endpoint={avatarEndpoint}
          value={avatar ?? null}
          onChange={setAvatar}
          email={whoami?.email ?? null}
          autoGravatar={false}
          preview={false}
          {...(classNames.avatar ? { classNames: classNames.avatar } : {})}
          {...(labels.avatarField ? { labels: labels.avatarField } : {})}
        />
      </div>

      <button className={classNames.button} type="submit" disabled={state === 'saving'}>
        {state === 'saving' ? (labels.saving ?? 'Saving…') : (labels.save ?? 'Save profile')}
      </button>

      {state === 'saved' && <p className={classNames.message}>{labels.saved ?? 'Saved.'}</p>}
      {state === 'error' && error && <p className={classNames.message}>{error}</p>}
    </form>
  )
}
