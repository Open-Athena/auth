import type { SelectionContext } from './selection-context.js'

/** The retained-login registry behind a gate's opt-in `retained` mode.
 * Caller owns gate IDs, random selectors and a stable >=256-bit HttpOnly handle;
 * handleHash must be a keyed hash, never the cookie value. All times are seconds.
 * Gate-wide admission/rate limiting and atomic email-proof completion are not here:
 * the gate consumes an email code, then adds the login (see the spec).
 */
export interface RetainedBinding {
  gateId: string
  browserSetId: string
  handleHash: string
}

export interface RetainedLimits {
  sessions: number
  pending: number
  gateBrowserSets: number
  gatePending: number
  browserTtlS: number
  pendingTtlS: number
  retryTtlS: number
  defaultSessionTtlS: number
}

export interface PendingIncoming extends RetainedBinding {
  expected: SelectionContext
  pendingId: string
  grantId: string
  /** Proof captured from validation; never accept a grant ID alone or raw token. */
  tokenHash: string
}

export interface CommitIncoming extends PendingIncoming {
  operationId: string
  /** Fresh opaque ID reserved for this operation, including exact retries. */
  newSessionId: string
  select: boolean
}

export interface IncomingResult {
  sessionId: string
  /** Historical committed version, NOT a current identity snapshot. */
  committedVersion: number
}

/** A browser set as it stands: its active selection and version. */
export interface RetainedBrowser {
  browserSetId: string
  activeSessionId: string | null
  version: number
  /** Absolute end of this browser's retention (epoch s): the handle cookie's Max-Age is capped by it. */
  expiresAt: number
}

/**
 * One retained login: its principal in the session-cookie format (`e:<email>`
 * or `g:<grant_id>`) and its own evidence window. The store reports a row by
 * its own expiry and revocation only; the gate still applies the live policy
 * or grant checks before treating it as usable.
 */
export interface RetainedSession {
  id: string
  sub: string
  issuedAt: number
  expiresAt: number
}

/** An incoming share link validated for this browser but not yet chosen: proof, not access. */
export interface RetainedPending {
  id: string
  grantId: string
  /** The proof captured at validation; a re-keyed link invalidates it. Server-side only. */
  tokenHash: string
  expiresAt: number
}

/** Add a freshly proven login (an email sign-in, or a legacy cookie's import) to a browser set. */
export interface AddSession extends RetainedBinding {
  expected: SelectionContext
  /** Fresh opaque ID; it is also the account's selector. */
  sessionId: string
  /** `e:<email>` or `g:<grant_id>`. A live login for the same `sub` in this set is replaced. */
  sub: string
  /** Kept from the original evidence: an imported cookie keeps its `iat`/`exp`, never extended. */
  issuedAt: number
  expiresAt: number
  /** Make it the active selection (a normal sign-in does). */
  select: boolean
}

/** Change the active selection (`sessionId` null = signed out here, keeping the others), or remove one login. */
export interface SelectSession extends RetainedBinding {
  expected: SelectionContext
  sessionId: string | null
}

export interface RetainedStore {
  /** Empty bootstrap only. Caller must establish the cookie before completion. */
  bootstrap(binding: RetainedBinding, nowS: number): Promise<boolean>
  /** The live browser set this handle names in this gate, or null. */
  browser(binding: Omit<RetainedBinding, 'browserSetId'>, nowS: number): Promise<RetainedBrowser | null>
  /** The set's unrevoked, unexpired logins, oldest first (ties in the order they were added). */
  sessions(binding: RetainedBinding, nowS: number): Promise<RetainedSession[]>
  /** The set's unconsumed, unexpired incoming links. */
  pendings(binding: RetainedBinding, nowS: number): Promise<RetainedPending[]>
  /** null: a stale `expected`, a dead set, or no room (`limits.sessions`, not counting the login it replaces). */
  addSession(input: AddSession, nowS: number): Promise<SelectionContext | null>
  /** Select a live member login, or none. null: stale `expected`, or not a live member. Never extends evidence. */
  select(input: SelectSession, nowS: number): Promise<SelectionContext | null>
  /**
   * Remove one login from this browser (not the grant, not other browsers).
   * Removing the active one leaves the set signed out: no other login is
   * silently selected in its place.
   */
  remove(input: SelectSession & { sessionId: string }, nowS: number): Promise<SelectionContext | null>
  /** Sign this browser out of every retained login, ending the set. */
  endBrowser(binding: RetainedBinding, nowS: number): Promise<boolean>
  /**
   * Bounded maintenance: delete at most `limit` rows a table that no longer
   * matter (expired or revoked logins, spent or expired pending proofs, retry
   * records past their window, ended browser sets). Logical expiry is enforced
   * whether or not this runs. Returns how many rows went.
   */
  cleanup(nowS: number, limit?: number): Promise<number>
  createPending(input: PendingIncoming, nowS: number): Promise<SelectionContext | null>
  /** null: rejected guards/input mismatch/expired replay; SQL/storage faults throw.
   * All grant, pending and retained rows must reside in this same database.
   * Replays return historical selectors, not renewed authentication evidence.
   */
  commitIncoming(input: CommitIncoming, nowS: number): Promise<IncomingResult | null>
}
