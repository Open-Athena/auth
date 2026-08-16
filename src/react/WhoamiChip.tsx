import type { ReactNode } from 'react'
import { useForgetWhoami } from './useWhoami.js'
import { type Whoami, displayName } from './types.js'

export interface WhoamiChipProps {
  whoami: Whoami | null | undefined
  /** Default `/api/auth/logout`. Pass null for Tier 1, where the edge owns the session. */
  logoutEndpoint?: string | null
  signOutLabel?: ReactNode
  onSignedOut?: () => void
  classNames?: Partial<Record<'root' | 'name' | 'button', string>>
}

/** Header chip: who you are, and how to stop being them. */
export function WhoamiChip({
  whoami,
  logoutEndpoint = '/api/auth/logout',
  signOutLabel = 'Sign out',
  onSignedOut,
  classNames = {},
}: WhoamiChipProps) {
  const forget = useForgetWhoami()
  const name = displayName(whoami)
  if (!whoami || !name) return null

  async function signOut() {
    if (logoutEndpoint) await fetch(logoutEndpoint, { method: 'POST', credentials: 'include' }).catch(() => {})
    forget()
    onSignedOut?.()
  }

  return (
    <div className={classNames.root}>
      <span className={classNames.name}>{name}</span>
      {logoutEndpoint !== null && (
        <button className={classNames.button} type="button" onClick={signOut}>
          {signOutLabel}
        </button>
      )}
    </div>
  )
}
