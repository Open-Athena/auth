import { isSessionLossReason } from '../core/denial.js'
import type { SessionLossReason } from '../core/denial.js'
import { DEFAULT_WHOAMI_ENDPOINT } from './identity.js'
import type { WhoamiSource } from './identity.js'

export interface UnauthenticatedEvent {
  reason: SessionLossReason | null
  endpoint: string
}

const listeners = new Set<(event: UnauthenticatedEvent) => void>()

/** Report a failed request, not a logout command: subscribers revalidate. */
export function reportUnauthenticated(reason?: SessionLossReason | null, source: WhoamiSource = {}): void {
  const event = { reason: isSessionLossReason(reason) ? reason : null, endpoint: source.endpoint ?? DEFAULT_WHOAMI_ENDPOINT }
  for (const listener of listeners) listener(event)
}

export function subscribeUnauthenticated(listener: (event: UnauthenticatedEvent) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
