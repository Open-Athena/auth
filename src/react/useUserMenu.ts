import { useQueryClient } from '@tanstack/react-query'
import { type HTMLAttributes, type KeyboardEvent, type MouseEvent, type ReactNode, useId, useState } from 'react'
import { AuthClientError, type AuthClient } from '../client/api.js'
import { announceSelectionChange, SelectionConflictError } from '../client/accounts.js'
import { displayName, type Whoami } from './types.js'
import { useForgetWhoami, WHOAMI_KEY } from './useWhoami.js'

/** An app's menu entry. */
export interface UserMenuItem {
  key: string
  label: ReactNode
  href?: string
  onClick?: (e: MouseEvent) => void
  /** Rendered as is instead of a link or button, e.g. an app's own submenu. Closing the menu is then its own business. */
  content?: ReactNode
  /** Who sees it: admins, email sign-ins (admins included), or share-link guests. Default everyone. */
  when?: 'admin' | 'sso' | 'guest'
}

/** A built-in or app entry to render. `accounts` is a place for `<AccountSwitcher>`, not a control. */
export interface UserMenuEntry {
  key: string
  label: ReactNode
  href?: string
  onClick?: (e: MouseEvent) => void
  content?: ReactNode
}

export interface UseUserMenuOptions {
  whoami: Whoami | null | undefined
  /** What the app knows better than the session, e.g. a registry's name or a GitHub avatar. */
  identity?: { name?: string | null; avatar?: string | null }
  client: Pick<AuthClient, 'basePath' | 'logout'>
  /** Listed after Profile, before accounts and sign out. */
  items?: readonly UserMenuItem[]
  /** Offer Profile to `sso` identities. Default true; false for a gate with no profile store. */
  profile?: boolean
  /** Open your own profile page instead of setting `profileOpen`. */
  onOpenProfile?: () => void
  /** After the server confirms a sign-out. The cached identity has already been dropped. */
  onSignedOut?: () => void
  labels?: Partial<Record<'profile' | 'accounts' | 'signOut' | 'signingOut' | 'signOutFailed' | 'trigger', string>>
}

export interface UseUserMenuResult {
  /** Null while loading or signed out: render your sign-in affordance, or nothing. */
  kind: 'sso' | 'guest' | null
  /** Null for an anonymous share link: show a fallback, and keep the way to sign out. */
  displayName: string | null
  avatar: string | null
  email: string | null
  isAdmin: boolean
  /** Whether this gate retains several logins (its whoami carries a selection). */
  retained: boolean
  items: readonly UserMenuEntry[]
  open: boolean
  setOpen: (open: boolean) => void
  profileOpen: boolean
  closeProfile: () => void
  signOut: () => Promise<void>
  signingOut: boolean
  /** The last sign-out's refusal, e.g. accounts changed in another tab. The identity has been re-read. */
  error: Error | null
  triggerProps: HTMLAttributes<HTMLElement>
  menuProps: HTMLAttributes<HTMLElement>
}

/**
 * The logic of an upper-right user menu, rendering nothing: who you are, what to
 * offer them, how they sign out, and the ARIA and keyboard props. Positioning and
 * outside-click dismissal are the renderer's, which is how `/react` stays free of
 * `@floating-ui/react`; `<UserMenu>` in `/react/user-menu` adds both.
 */
export function useUserMenu({
  whoami,
  identity,
  client,
  items = [],
  profile = true,
  onOpenProfile,
  onSignedOut,
  labels = {},
}: UseUserMenuOptions): UseUserMenuResult {
  const queryClient = useQueryClient()
  const forget = useForgetWhoami()
  const menuId = useId()
  const [open, setOpenState] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const setOpen = (next: boolean) => {
    setOpenState(next)
    if (!next) setProfileOpen(false)
  }

  const kind = !whoami ? null : whoami.kind === 'sso' ? 'sso' : 'guest'
  const isAdmin = whoami?.admin === true
  const selection = whoami?.selection ?? null
  const retained = selection !== null
  const name = (whoami && identity?.name) || displayName(whoami)
  const signOutLabel = labels.signOut ?? 'Sign out'

  async function signOut(): Promise<void> {
    if (signingOut) return
    setSigningOut(true)
    setError(null)
    try {
      await client.logout({ selection })
      if (retained) announceSelectionChange(client.basePath)
      setOpen(false)
      forget()
      onSignedOut?.()
    } catch (e) {
      const conflict = e instanceof AuthClientError && e.status === 409
      setError(conflict ? new SelectionConflictError() : new Error(labels.signOutFailed ?? 'Could not sign out. Please try again.'))
      // Still signed in, and possibly as someone else: show who, from the server.
      void queryClient.invalidateQueries({ queryKey: WHOAMI_KEY })
    } finally {
      setSigningOut(false)
    }
  }

  const visible = (when: UserMenuItem['when']) =>
    when === undefined || (when === 'admin' ? isAdmin : when === kind)

  const entries: UserMenuEntry[] = !kind
    ? []
    : [
        ...(kind === 'sso' && profile
          ? [{
              key: 'profile',
              label: labels.profile ?? 'Profile',
              onClick: () => {
                if (onOpenProfile) {
                  setOpen(false)
                  onOpenProfile()
                } else setProfileOpen(true)
              },
            }]
          : []),
        ...items
          .filter(item => visible(item.when))
          .map(({ key, label, href, onClick, content }) => ({
            key,
            label,
            ...(content === undefined ? {} : { content }),
            ...(href === undefined ? {} : { href }),
            onClick: (e: MouseEvent) => {
              onClick?.(e)
              setOpen(false)
            },
          })),
        ...(retained ? [{ key: 'accounts', label: labels.accounts ?? 'Accounts' }] : []),
        { key: 'sign-out', label: signingOut ? (labels.signingOut ?? 'Signing out…') : signOutLabel, onClick: () => void signOut() },
      ]

  const triggerLabel = labels.trigger ?? (name ? `Signed in as ${name}` : 'Signed in with a share link')

  return {
    kind,
    displayName: name,
    avatar: whoami ? (identity?.avatar ?? whoami.subject?.avatar ?? null) : null,
    email: whoami?.email ?? null,
    isAdmin,
    retained,
    items: entries,
    open,
    setOpen,
    profileOpen,
    closeProfile: () => setProfileOpen(false),
    signOut,
    signingOut,
    error,
    triggerProps: {
      'aria-label': triggerLabel,
      'aria-haspopup': 'true',
      'aria-expanded': open,
      'aria-controls': open ? menuId : undefined,
      onClick: () => setOpen(!open),
    },
    menuProps: {
      id: menuId,
      // A dialog holding menus, not one menu: the identity header and the account
      // switcher's list aren't menu items.
      role: 'dialog',
      'aria-label': 'Account',
      onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
        if (e.key === 'Escape') {
          setOpen(false)
          return
        }
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
        const all = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'))
        if (!all.length) return
        e.preventDefault()
        const at = all.indexOf(document.activeElement as HTMLElement)
        const step = e.key === 'ArrowDown' ? 1 : -1
        const next = at === -1 ? (step === 1 ? 0 : all.length - 1) : (at + step + all.length) % all.length
        all[next]!.focus()
      },
    },
  }
}
