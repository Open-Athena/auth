import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useEffect, useMemo } from 'react'
import { createAccountsClient, onSelectionChange, SelectionConflictError } from '../client/accounts.js'
import type { AccountView, AccountsResponse, IncomingView } from '../core/http.js'
import { Avatar } from './Avatar.js'
import { WHOAMI_KEY } from './useWhoami.js'

export const ACCOUNTS_KEY = ['oa-auth', 'accounts'] as const

export interface UseAccountsOptions {
  /** The auth routes' base path (default `/api/auth`). */
  basePath?: string
  enabled?: boolean
}

export interface UseAccountsResult {
  /** undefined while loading; null when the browser holds no accounts (or the gate doesn't retain them). */
  accounts: AccountsResponse | null | undefined
  select: (id: string | null) => Promise<void>
  remove: (id: string) => Promise<void>
  acceptIncoming: (id: string) => Promise<void>
  signOut: () => Promise<void>
  signOutAll: () => Promise<void>
  /** A mutation in flight: disable the controls. */
  busy: boolean
  /** The last refusal, e.g. "Your accounts changed in another tab…" (the list has already been refreshed). */
  error: Error | null
}

/**
 * A browser's retained logins (a gate in `retained` mode): the list, and every
 * way to change it. After any change, here or in another tab, the identity
 * and the list are re-read from the server, and the private data an app keys
 * by identity should be too: watch `accounts.active` or the whoami query.
 */
export function useAccounts({ basePath = '/api/auth', enabled = true }: UseAccountsOptions = {}): UseAccountsResult {
  const qc = useQueryClient()
  const api = useMemo(() => createAccountsClient({ basePath }), [basePath])
  const key = [...ACCOUNTS_KEY, basePath]
  const q = useQuery({ queryKey: key, queryFn: () => api.list(), enabled, retry: false, refetchOnWindowFocus: true })

  const refreshAll = () => {
    void qc.invalidateQueries({ queryKey: [...ACCOUNTS_KEY, basePath] })
    void qc.invalidateQueries({ queryKey: WHOAMI_KEY })
  }
  // Another tab switched or signed out: look again.
  useEffect(
    () =>
      onSelectionChange(() => {
        void qc.invalidateQueries({ queryKey: [...ACCOUNTS_KEY, basePath] })
        void qc.invalidateQueries({ queryKey: WHOAMI_KEY })
      }, basePath),
    [qc, basePath],
  )

  const m = useMutation<unknown, Error, () => Promise<unknown>>({
    mutationFn: run => run(),
    onSuccess: data => {
      if (data && typeof data === 'object' && 'accounts' in data) qc.setQueryData(key, data)
      // The identity changed (or may have): every observer re-reads it, rather
      // than rendering the previous account's view for a moment.
      void qc.resetQueries({ queryKey: WHOAMI_KEY })
      void qc.invalidateQueries({ queryKey: key })
    },
    onError: e => {
      if (e instanceof SelectionConflictError) refreshAll()
    },
  })
  const selection = () => q.data?.selection ?? null
  const run = (f: () => Promise<unknown>) => m.mutateAsync(f).then(() => {}, () => {})

  return {
    accounts: enabled && q.isPending ? undefined : (q.data ?? null),
    select: id => run(() => api.select(id, selection())),
    remove: id => run(() => api.remove(id, selection())),
    acceptIncoming: id => run(() => api.acceptIncoming(id, selection())),
    signOut: () => run(() => api.logout(selection())),
    signOutAll: () => run(() => api.logoutAll()),
    busy: m.isPending,
    error: m.error,
  }
}

export interface AccountSwitcherProps {
  basePath?: string
  /** Where "Add another account" goes: your sign-in page, or Google's start URL with `?account=choose`. Omit to hide it. */
  addAccountHref?: string
  /** Called after any successful change (close a popover, say). */
  onChanged?: () => void
  labels?: Partial<
    Record<'heading' | 'add' | 'signOut' | 'signOutAll' | 'remove' | 'link' | 'verified' | 'incoming' | 'useLink' | 'current', ReactNode>
  >
  classNames?: Partial<
    Record<'root' | 'list' | 'item' | 'active' | 'switch' | 'remove' | 'tag' | 'incoming' | 'actions' | 'button' | 'error', string>
  >
}

const who = (a: { kind?: AccountView['kind']; email: string | null; name: string | null; subject: AccountView['subject'] }): string =>
  a.subject?.name ?? (a.kind === 'grant' ? (a.name ?? a.email ?? 'Share link') : (a.email ?? a.name ?? 'Account'))

/**
 * The browser's accounts: switch with one click, add another, take one off,
 * or sign out of all. A share-link login is always labelled as one, so a
 * guest can't pass for a verified person by name and face. With a single
 * account and no incoming link it is just that account and the sign-out
 * actions: no picker to step through.
 */
export function AccountSwitcher({ basePath, addAccountHref, onChanged, labels = {}, classNames = {} }: AccountSwitcherProps) {
  const a = useAccounts({ basePath })
  const l = {
    heading: 'Accounts',
    add: 'Add another account',
    signOut: 'Sign out',
    signOutAll: 'Sign out of all accounts',
    remove: 'Remove',
    link: 'share link',
    verified: 'verified',
    incoming: 'Opened a share link',
    useLink: 'Use it',
    current: 'current',
    ...labels,
  }
  if (!a.accounts) return null
  const { accounts, incoming } = a.accounts
  const done = (p: Promise<void>) => p.then(() => !a.error && onChanged?.())
  const many = accounts.length > 1

  const row = (x: AccountView) => (
    <li key={x.id} className={[classNames.item, x.active && classNames.active].filter(Boolean).join(' ') || undefined}>
      <button
        type="button"
        className={classNames.switch}
        disabled={a.busy || x.active}
        aria-current={x.active ? 'true' : undefined}
        onClick={() => done(a.select(x.id))}
      >
        <Avatar src={x.subject?.avatar ?? null} name={who(x)} size={24} />
        <span>{who(x)}</span>
        {x.email && who(x) !== x.email && <span>{x.email}</span>}
        <span className={classNames.tag}>{x.kind === 'grant' ? l.link : l.verified}</span>
        {x.active && many && <span className={classNames.tag}>{l.current}</span>}
      </button>
      {many && (
        <button type="button" className={classNames.remove} disabled={a.busy} onClick={() => done(a.remove(x.id))} aria-label={`${l.remove} ${who(x)}`}>
          ×
        </button>
      )}
    </li>
  )

  const offer = (i: IncomingView) => (
    <li key={i.id} className={classNames.incoming}>
      <span>
        {l.incoming}: {who({ ...i, kind: 'grant' })} <span className={classNames.tag}>{l.link}</span>
      </span>
      <button type="button" className={classNames.button} disabled={a.busy} onClick={() => done(a.acceptIncoming(i.id))}>
        {l.useLink}
      </button>
    </li>
  )

  return (
    <div className={classNames.root} role="group" aria-label={typeof l.heading === 'string' ? l.heading : 'Accounts'}>
      <ul className={classNames.list}>
        {accounts.map(row)}
        {incoming.map(offer)}
      </ul>
      {a.error && (
        <p className={classNames.error} role="alert">
          {a.error.message}
        </p>
      )}
      <div className={classNames.actions}>
        {addAccountHref && (
          <a className={classNames.button} href={addAccountHref}>
            {l.add}
          </a>
        )}
        {accounts.some(x => x.active) && (
          <button type="button" className={classNames.button} disabled={a.busy} onClick={() => done(a.signOut())}>
            {l.signOut}
          </button>
        )}
        {many && (
          <button type="button" className={classNames.button} disabled={a.busy} onClick={() => done(a.signOutAll())}>
            {l.signOutAll}
          </button>
        )}
      </div>
    </div>
  )
}
