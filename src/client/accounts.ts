/**
 * Retained logins from the browser: list this browser's accounts, switch,
 * remove one, take up an incoming share link, sign out of one or all. Every
 * change sends the selection the page last saw (`X-OA-Selection-Context`), so
 * a page still showing account A can't act as B after another tab switched:
 * the server answers 409, and the page refreshes and asks again.
 *
 * Tabs hear about each other's changes through a `BroadcastChannel` per auth
 * base path. A notice carries nothing but "look again": every tab re-reads the
 * server's truth.
 */
import type { AccountsResponse } from '../core/http.js'

export const SELECTION_HEADER = 'X-OA-Selection-Context'

export interface AccountsClientOptions {
  /** The auth routes' base path (default `/api/auth`). */
  basePath?: string
  fetch?: typeof globalThis.fetch
}

/** A 409 meaning "the browser's accounts changed since this page looked": refresh, then let the person retry. */
export class SelectionConflictError extends Error {
  constructor() {
    super('Your accounts changed in another tab; review and try again.')
    this.name = 'SelectionConflictError'
  }
}

/** Any other refusal, with the server's error code (`retained-login-capacity`, `incoming-unavailable`, …). */
export class AccountsError extends Error {
  constructor(readonly status: number, readonly code: string | null) {
    super(code ?? `accounts request failed (${status})`)
    this.name = 'AccountsError'
  }
}

const channelName = (basePath: string) => `oa-auth:${basePath}`

/** Tell this browser's other tabs that the selection changed. A no-op where `BroadcastChannel` doesn't exist. */
export function announceSelectionChange(basePath = '/api/auth'): void {
  if (typeof BroadcastChannel === 'undefined') return
  const ch = new BroadcastChannel(channelName(basePath))
  ch.postMessage({ type: 'selection' })
  ch.close()
}

/** Run `listener` when another tab changes this browser's selection. Returns the unsubscribe. */
export function onSelectionChange(listener: () => void, basePath = '/api/auth'): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => {}
  const ch = new BroadcastChannel(channelName(basePath))
  ch.onmessage = e => {
    if ((e.data as { type?: unknown } | null)?.type === 'selection') listener()
  }
  return () => ch.close()
}

export function createAccountsClient({ basePath = '/api/auth', fetch = globalThis.fetch }: AccountsClientOptions = {}) {
  const base = basePath.replace(/\/+$/, '')

  async function call(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${base}${path}`, { credentials: 'same-origin', cache: 'no-store', ...init })
  }

  async function read(res: Response): Promise<unknown> {
    const text = await res.text()
    try {
      return text ? JSON.parse(text) : null
    } catch {
      return null
    }
  }

  async function mutate(path: string, selection: string | null, input: unknown = {}, announce = true): Promise<unknown> {
    const res = await call(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(selection ? { [SELECTION_HEADER]: selection } : {}) },
      body: JSON.stringify(input),
    })
    const body = await read(res)
    if (res.status === 409 && (body as { error?: unknown } | null)?.error === 'selection_context_conflict') {
      throw new SelectionConflictError()
    }
    if (!res.ok) {
      const code = (body as { error?: unknown } | null)?.error
      throw new AccountsError(res.status, typeof code === 'string' ? code : null)
    }
    if (announce) announceSelectionChange(basePath)
    return body
  }

  return {
    /** This browser's accounts, or null when it holds none (or the gate isn't in retained mode). */
    async list(): Promise<AccountsResponse | null> {
      const res = await call('/accounts')
      if (res.status === 404 || res.status === 401) return null
      if (!res.ok) throw new AccountsError(res.status, null)
      return (await read(res)) as AccountsResponse
    },
    /** Switch to one of this browser's accounts (`null`: to none, keeping them all). */
    select: (id: string | null, selection: string | null) =>
      mutate('/accounts/select', selection, { id }) as Promise<AccountsResponse>,
    /** Take an account off this browser (not the link, not other browsers). */
    remove: (id: string, selection: string | null) => mutate('/accounts/remove', selection, { id }) as Promise<AccountsResponse>,
    /** Use an incoming share link that was held while another account was active. */
    acceptIncoming: (id: string, selection: string | null) =>
      mutate('/accounts/incoming', selection, { id }) as Promise<AccountsResponse>,
    /** Sign out of the active account only; the browser keeps the others. */
    logout: (selection: string | null) => mutate('/logout', selection),
    /** Sign this browser out of every account. */
    logoutAll: () => mutate('/logout-all', null),
  }
}

export type AccountsClient = ReturnType<typeof createAccountsClient>
