/** Grants (share links / magic links) and the identities they resolve to. */

/** Optional pre-loaded identity, so a gated view can greet and watermark by name. */
export interface Subject {
  first?: string
  last?: string
  email?: string
  avatar?: string
}

export interface Grant {
  id: string
  /** Admin-side label: "Bob Smith (donor)". */
  name: string | null
  /** Freeform: why this link exists. */
  note: string | null
  subject: Subject | null
  /** If set, magic-link semantics: the grant is bound to this address. */
  email: string | null
  scopes: string[]
  /** null = unlimited. Counts *sessions minted*, not requests. */
  maxRedeems: number | null
  redeems: number
  /** Epoch seconds; null = never expires. */
  expiresAt: number | null
  /** Seconds; null = inherit the app default. */
  sessionTtlS: number | null
  createdAt: number
  createdBy: string
  /** Set = no new redemptions; sessions already minted keep working. */
  disabledAt: number | null
  /** Set = no new redemptions, *and* every session it minted dies. */
  revokedAt: number | null
  /**
   * Whether `expiresAt` also ends sessions already minted. Default true, which
   * is the data-room reading of "expires Friday". False makes `expiresAt` a
   * redemption window only, and a session then lives out its own `sessionTtlS`.
   */
  expiryEndsSessions: boolean
  /**
   * Rotation epoch (epoch seconds), or null. Set by `gate.rotate({ endSessions:
   * true })`: a grant session whose `iat` predates this is rejected on its next
   * request, so re-keying a leaked link can also boot whoever is already inside.
   * A plain re-key leaves it null and existing sessions untouched.
   */
  sessionsInvalidBefore: number | null
  firstUsedAt: number | null
  lastUsedAt: number | null
}

export interface NewGrant {
  name?: string | null
  note?: string | null
  subject?: Subject | null
  email?: string | null
  scopes: string[]
  maxRedeems?: number | null
  expiresAt?: number | null
  sessionTtlS?: number | null
  /** Default true — see `Grant.expiryEndsSessions`. */
  expiryEndsSessions?: boolean
  createdBy: string
}

/** The knobs an admin can change after minting. Everything else is immutable. */
export interface GrantPatch {
  name?: string | null
  note?: string | null
  expiresAt?: number | null
  maxRedeems?: number | null
  sessionTtlS?: number | null
  expiryEndsSessions?: boolean
}

export type Auth =
  | { kind: 'sso'; email: string; admin: boolean; scopes: string[]; subject: Subject | null }
  | { kind: 'grant'; grant: Grant; admin: false; scopes: string[] }

/** Wildcard scope: granted to admins, matches every `hasScope` check. */
export const ALL_SCOPES = '*'

export function hasScope(auth: Auth, scope: string): boolean {
  return auth.scopes.includes(ALL_SCOPES) || auth.scopes.includes(scope)
}

/** Parse the space-separated `scopes` column. Tolerates commas, since humans type them. */
export const parseScopes = (s: string | null | undefined): string[] => (s ?? '').split(/[\s,]+/).filter(Boolean)

export const formatScopes = (scopes: readonly string[]): string => scopes.join(' ')
