/**
 * Re-exports the shipped in-memory stores under the names this suite uses.
 * They live in `src/testing` because consumers need them too — testing a gated
 * route otherwise means standing up D1 to assert "a revoked link 401s".
 */
import type { AccessEvent } from '../src/core/audit.js'

export {
  memoryAudit,
  memoryGrantStore as memoryStore,
  memoryRequestStore,
  type MemoryAudit,
  type MemoryGrantStore as MemoryStore,
  type MemoryRequestStore,
} from '../src/testing/index.js'

/** The audit fields a test cares about, with the noisy request metadata dropped. */
export interface LoggedEvent {
  event: string
  grantId: string | null
  sessionSub: string | null
  path: string | null
  reason: string | null
}

export const logged = (events: readonly AccessEvent[]): LoggedEvent[] =>
  events.map(e => ({
    event: e.event,
    grantId: e.grantId ?? null,
    sessionSub: e.sessionSub ?? null,
    path: e.path ?? null,
    reason: e.reason ?? null,
  }))
