import {
  autoUpdate, flip, FloatingFocusManager, FloatingPortal, offset, shift, useDismiss, useFloating, useInteractions,
} from '@floating-ui/react'
import { Fragment, type ReactNode } from 'react'
import type { AuthClient } from '../client/api.js'
import { AccountSwitcher, type AccountSwitcherProps } from './Accounts.js'
import { Avatar } from './Avatar.js'
import { ProfilePanel, type ProfilePanelProps } from './ProfilePanel.js'
import { type UseUserMenuOptions, type UserMenuEntry, useUserMenu } from './useUserMenu.js'
import type { Whoami } from './types.js'

export interface UserMenuProps extends Omit<UseUserMenuOptions, 'client' | 'whoami'> {
  whoami: Whoami | null | undefined
  client: AuthClient
  /** Rendered when signed out, e.g. a sign-in link. Default nothing. */
  signedOut?: ReactNode
  /** Where "Add another account" goes in a retained gate's account list. */
  addAccountHref?: string
  /** Name for an anonymous share link, whose trigger shows `?`. */
  anonymousLabel?: ReactNode
  guestLabel?: ReactNode
  backLabel?: ReactNode
  /** Trigger face size, in pixels. */
  size?: number
  accountSwitcher?: Pick<AccountSwitcherProps, 'labels' | 'classNames'>
  profilePanel?: Pick<ProfilePanelProps, 'labels' | 'classNames'>
  classNames?: Partial<Record<'trigger' | 'popover' | 'identity' | 'name' | 'email' | 'tag' | 'menu' | 'item' | 'back' | 'error', string>>
}

const DEFAULTS = {
  trigger: 'oa-ui-um-trigger',
  popover: 'oa-ui oa-ui-um-pop',
  identity: 'oa-ui-um-identity',
  name: 'oa-ui-um-name',
  email: 'oa-ui-um-email',
  tag: 'oa-ui-tag',
  menu: 'oa-ui-um-menu',
  item: 'oa-ui-um-item',
  back: 'oa-ui-um-item',
  error: 'oa-ui-error',
}

/**
 * The upper-right menu: an avatar opening who you are, Profile, the app's own
 * entries, retained accounts, and sign out. Built only on `useUserMenu`, so an
 * app can restyle this or write its own. A share link is always labelled as one,
 * so a guest can't pass for a verified person by name and face.
 */
export function UserMenu({
  whoami,
  client,
  signedOut = null,
  addAccountHref,
  anonymousLabel = 'Anonymous link',
  guestLabel = 'share link',
  backLabel = 'Back',
  size = 28,
  accountSwitcher,
  profilePanel,
  classNames,
  ...options
}: UserMenuProps) {
  const cx = { ...DEFAULTS, ...classNames }
  const m = useUserMenu({ whoami, client, ...options })
  const { refs, floatingStyles, context } = useFloating({
    open: m.open,
    onOpenChange: m.setOpen,
    placement: 'bottom-end',
    middleware: [offset(6), flip(), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  })
  const { getReferenceProps, getFloatingProps } = useInteractions([useDismiss(context)])
  if (whoami === undefined) return null
  if (!m.kind) return <>{signedOut}</>

  const row = (entry: UserMenuEntry) =>
    entry.content !== undefined ? (
      <Fragment key={entry.key}>{entry.content}</Fragment>
    ) : entry.href === undefined ? (
      <button key={entry.key} type="button" role="menuitem" className={cx.item} disabled={entry.key === 'sign-out' && m.signingOut} onClick={entry.onClick}>
        {entry.label}
      </button>
    ) : (
      <a key={entry.key} role="menuitem" className={cx.item} href={entry.href} onClick={entry.onClick}>
        {entry.label}
      </a>
    )
  const at = m.items.findIndex(entry => entry.key === 'accounts')
  const before = at === -1 ? m.items.slice(0, -1) : m.items.slice(0, at)
  const signOut = m.items[m.items.length - 1]!

  return (
    <>
      <button type="button" className={cx.trigger} ref={refs.setReference} {...getReferenceProps(m.triggerProps)}>
        <Avatar src={m.avatar} name={m.displayName} size={size} initials={m.displayName ? undefined : '?'} />
      </button>
      {m.open && (
        <FloatingPortal>
          <FloatingFocusManager context={context} modal={false}>
            <div className={cx.popover} ref={refs.setFloating} style={floatingStyles} {...getFloatingProps(m.menuProps)}>
              {m.profileOpen ? (
                <>
                  <button type="button" className={cx.back} onClick={m.closeProfile}>
                    {backLabel}
                  </button>
                  <ProfilePanel endpoint={`${client.basePath}/profile`} whoami={whoami} onSaved={m.closeProfile} {...profilePanel} />
                </>
              ) : (
                <>
                  <div className={cx.identity}>
                    <Avatar src={m.avatar} name={m.displayName} size={36} initials={m.displayName ? undefined : '?'} />
                    <div>
                      <div className={cx.name}>{m.displayName ?? anonymousLabel}</div>
                      {m.email && m.email !== m.displayName && <div className={cx.email}>{m.email}</div>}
                      {m.kind === 'guest' && <span className={cx.tag}>{guestLabel}</span>}
                    </div>
                  </div>
                  {before.length > 0 && (
                    <div role="menu" className={cx.menu}>
                      {before.map(row)}
                    </div>
                  )}
                  {at !== -1 && (
                    <AccountSwitcher
                      basePath={client.basePath}
                      addAccountHref={addAccountHref}
                      hideSignOut
                      onChanged={() => m.setOpen(false)}
                      {...accountSwitcher}
                    />
                  )}
                  <div role="menu" className={cx.menu}>
                    {row(signOut)}
                  </div>
                  {m.error && (
                    <p className={cx.error} role="alert">
                      {m.error.message}
                    </p>
                  )}
                </>
              )}
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      )}
    </>
  )
}
