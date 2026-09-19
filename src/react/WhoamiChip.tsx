import type { ReactNode } from 'react'
import { Avatar } from './Avatar.js'
import { useForgetWhoami } from './useWhoami.js'
import { type Whoami, displayName } from './types.js'

export interface WhoamiChipProps {
  whoami: Whoami | null | undefined
  /** Default `/api/auth/logout`. Pass null for Tier 1, where the edge owns the session. */
  logoutEndpoint?: string | null
  signOutLabel?: ReactNode
  /**
   * Shown when the identity has no name — an anonymous share link. Without it
   * the chip would render nothing, taking the sign-out control with it, which
   * is the one case where a visitor most needs a way out.
   */
  anonymousLabel?: ReactNode
  onSignedOut?: () => void
  /** Show an `<Avatar>` before the name. Off by default: it changes the layout. */
  avatar?: boolean | { src?: string | null; size?: number }
  /**
   * Make the avatar + name a click target — "click your face to edit it". When
   * set, they render as a `<button>` calling this, so an app can open a
   * `<ProfilePanel>` without wiring its own hit area.
   */
  onOpenProfile?: () => void
  classNames?: Partial<Record<'root' | 'name' | 'button' | 'avatar' | 'identity', string>>
}

/** Header chip: who you are, and how to stop being them. */
export function WhoamiChip({
  whoami,
  logoutEndpoint = '/api/auth/logout',
  signOutLabel = 'Sign out',
  anonymousLabel = 'Anonymous link',
  onSignedOut,
  avatar = false,
  onOpenProfile,
  classNames = {},
}: WhoamiChipProps) {
  const forget = useForgetWhoami()
  const name = displayName(whoami)
  if (!whoami) return null

  async function signOut() {
    if (logoutEndpoint) await fetch(logoutEndpoint, { method: 'POST', credentials: 'include' }).catch(() => {})
    forget()
    onSignedOut?.()
  }

  const face = avatar && (
    <Avatar whoami={whoami} className={classNames.avatar} {...(typeof avatar === 'object' ? avatar : {})} />
  )
  const label = <span className={classNames.name}>{name ?? anonymousLabel}</span>

  return (
    <div className={classNames.root}>
      {onOpenProfile ? (
        // A single hit area over face + name, so "click your face → edit it"
        // needs no layout of the app's own.
        <button className={classNames.identity} type="button" onClick={onOpenProfile}>
          {face}
          {label}
        </button>
      ) : (
        <>
          {face}
          {label}
        </>
      )}
      {logoutEndpoint !== null && (
        <button className={classNames.button} type="button" onClick={signOut}>
          {signOutLabel}
        </button>
      )}
    </div>
  )
}
