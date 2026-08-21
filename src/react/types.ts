/**
 * The two identity shapes, and the source that produces each.
 *
 * marin's `AuthGate` and watchy's `useWhoami` are the *same UX* differing only
 * in where identity comes from: the edge (`/cdn-cgi/access/get-identity`, Tier
 * 1) or the app (`/api/auth/whoami`, Tier 2). Making the source a parameter is
 * what turns a Tier-1 → Tier-2 upgrade into a one-line change.
 */
import type { Subject } from '../core/types.js'

export type WhoamiSource =
  | { kind: 'edge'; endpoint?: string }
  | { kind: 'app'; endpoint?: string }

export const DEFAULT_ENDPOINTS: Record<WhoamiSource['kind'], string> = {
  edge: '/cdn-cgi/access/get-identity',
  app: '/api/auth/whoami',
}

export interface SsoWhoami {
  kind: 'sso'
  email: string
  admin: boolean
  scopes: string[]
}

export interface GrantWhoami {
  kind: 'grant'
  /** The grant's id — the session's subject is `g:<id>`. Not a secret. */
  id: string
  name: string | null
  subject: Subject | null
  email: string | null
  scopes: string[]
  admin: false
  expiresAt: number | null
}

/** What `/api/auth/whoami` returns (Tier 2). */
export type AppWhoami = SsoWhoami | GrantWhoami

/** What CF Access `get-identity` returns (Tier 1) — more fields than we use. */
export interface EdgeWhoami {
  email?: string
  name?: string
  user_uuid?: string
  [key: string]: unknown
}

export type Whoami = AppWhoami | EdgeWhoami

/**
 * Best available human label: the *person* first, then the link's memo, then an
 * email.
 *
 * Subject before name, because they answer different questions. `name` is an
 * admin's memo — "Q3 board packet", "test-1756800000" — written for the table
 * it appears in, while `subject` is who the link was minted *for*. Preferring
 * the memo meant a link with both rendered "Private link for Q3 board packet",
 * which is the wrong noun in the wrong sentence.
 *
 * `EdgeWhoami`'s index signature makes the union un-narrowable by `kind` alone
 * (every member structurally admits a `kind` field), so this reads fields off a
 * single widened view rather than pretending the discriminant works here.
 */
export function displayName(whoami: Whoami | null | undefined): string | null {
  if (!whoami) return null
  const w = whoami as Partial<GrantWhoami> & Partial<SsoWhoami> & EdgeWhoami
  if (w.kind === 'grant') {
    const subject: Subject = w.subject ?? {}
    const full = [subject.first, subject.last].filter(Boolean).join(' ')
    return full || w.name || subject.email || w.email || null
  }
  if (w.kind === 'sso') return w.email ?? null
  return w.name ?? w.email ?? null
}

export function hasScope(whoami: Whoami | null | undefined, scope: string): boolean {
  const scopes = (whoami as { scopes?: unknown } | null | undefined)?.scopes
  if (!Array.isArray(scopes)) return false
  return scopes.includes('*') || scopes.includes(scope)
}
