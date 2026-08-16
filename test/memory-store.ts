/** In-memory GrantStore + AuditSink, so core tests don't need a database. */
import type { AccessEvent, AuditSink } from '../src/core/audit.js'
import type { GrantStore } from '../src/core/store.js'
import type { Grant } from '../src/core/types.js'

export interface MemoryStore extends GrantStore {
  rows: Map<string, Grant>
  hashes: Map<string, string> // tokenHash -> id
}

export function memoryStore(): MemoryStore {
  const rows = new Map<string, Grant>()
  const hashes = new Map<string, string>()
  const get = (id: string): Grant | null => rows.get(id) ?? null

  return {
    rows,
    hashes,
    async byId(id) {
      return get(id)
    },
    async byTokenHash(tokenHash) {
      const id = hashes.get(tokenHash)
      return id ? get(id) : null
    },
    async insert(grant, tokenHash) {
      rows.set(grant.id, { ...grant })
      hashes.set(tokenHash, grant.id)
    },
    async redeem(id, nowS) {
      const g = rows.get(id)
      if (!g) return null
      if (g.revokedAt !== null) return null
      if (g.expiresAt !== null && g.expiresAt <= nowS) return null
      if (g.maxRedeems !== null && g.redeems >= g.maxRedeems) return null
      const next: Grant = { ...g, redeems: g.redeems + 1, firstUsedAt: g.firstUsedAt ?? nowS, lastUsedAt: nowS }
      rows.set(id, next)
      return next
    },
    async touch(id, nowS, minIntervalS) {
      const g = rows.get(id)
      if (!g) return
      if (g.lastUsedAt !== null && g.lastUsedAt >= nowS - minIntervalS) return
      rows.set(id, { ...g, lastUsedAt: nowS })
    },
    async revoke(id, nowS) {
      const g = rows.get(id)
      if (!g || g.revokedAt !== null) return false
      rows.set(id, { ...g, revokedAt: nowS })
      return true
    },
    async list(opts) {
      return [...rows.values()]
        .filter(g => opts?.includeRevoked || g.revokedAt === null)
        .sort((a, b) => b.createdAt - a.createdAt)
    },
  }
}

export interface MemoryAudit extends AuditSink {
  events: AccessEvent[]
}

export function memoryAudit(): MemoryAudit {
  const events: AccessEvent[] = []
  return { events, log: async e => void events.push(e) }
}

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
