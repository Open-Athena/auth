import type { SelectionContext } from './selection-context.js'

/** Internal, opt-in feasibility substrate, not the public session registry.
 * Caller owns gate IDs, random selectors and a stable >=256-bit HttpOnly handle;
 * handleHash must be a keyed hash, never the cookie value. All times are seconds.
 * Admission/rate limiting, live request authorization, email/provider completion,
 * listing/switch/logout, cleanup and route/cookie integration remain pending.
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

export interface RetainedStore {
  /** Empty bootstrap only. Caller must establish the cookie before completion. */
  bootstrap(binding: RetainedBinding, nowS: number): Promise<boolean>
  createPending(input: PendingIncoming, nowS: number): Promise<SelectionContext | null>
  /** null: rejected guards/input mismatch/expired replay; SQL/storage faults throw.
   * All grant, pending and retained rows must reside in this same database.
   * Replays return historical selectors, not renewed authentication evidence.
   */
  commitIncoming(input: CommitIncoming, nowS: number): Promise<IncomingResult | null>
}
