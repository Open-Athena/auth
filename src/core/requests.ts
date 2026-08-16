/**
 * Request access ("enter your email") — the second affordance on the wall, next
 * to SSO. See specs/share-links-and-audit.md §2.
 *
 * There is no pre-verification round-trip: approval is *delivered by email*, so
 * someone who types a stranger's address merely causes mail to the real owner.
 * That is cheaper than a confirm-then-request dance and exactly as safe.
 */
import type { Grant } from './types.js'

export type RequestStatus = 'pending' | 'approved' | 'denied' | 'auto'

export interface AccessRequest {
  id: string
  email: string
  name: string | null
  note: string | null
  createdAt: number
  status: RequestStatus
  decidedAt: number | null
  decidedBy: string | null
  /** The grant minted on approval — the thing actually delivered to them. */
  grantId: string | null
}

/**
 * One pluggable hook for every outbound message, which answers both open
 * questions it was raised against: request-access notification transport and
 * magic-link delivery are the same problem, and neither belongs in the kernel.
 * Apps wire it to a Slack webhook, an email provider, or a `mailto:` prefill.
 */
export type Notify = (event: NotifyEvent) => Promise<void>

export type NotifyEvent =
  /** Someone is waiting on an admin. */
  | { kind: 'access-requested'; request: AccessRequest }
  /** A grant exists for them; `token` appears here and nowhere else, ever again. */
  | { kind: 'access-granted'; request: AccessRequest; grant: Grant; token: string }
  | { kind: 'access-denied'; request: AccessRequest }

export const noopNotify: Notify = async () => {}

/**
 * Deliberately permissive: one `@`, no whitespace, a dot in the domain. Address
 * syntax is famously baroque, and the real validation is that approval mail has
 * to arrive — rejecting exotic-but-legal addresses here would only lock out
 * real people.
 */
export function isEmailish(email: string): boolean {
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email)
}

export interface RateLimit {
  /** Max requests per email within `windowS`. Default 3. */
  perEmail?: number
  /** Max requests per client IP within `windowS`. Default 10. */
  perIp?: number
  /** Default 1 hour. */
  windowS?: number
}

export const DEFAULT_RATE_LIMIT: Required<RateLimit> = { perEmail: 3, perIp: 10, windowS: 3600 }
