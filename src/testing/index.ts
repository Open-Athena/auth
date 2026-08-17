/**
 * In-memory stores for tests — this package's own, and any consumer's.
 *
 * Shipped rather than kept in `test/` because every adopter hits the same wall:
 * testing a gated route needs a `GrantStore`, and standing up D1 (or any SQL) to
 * assert "a revoked link 401s" is a lot of ceremony for a unit test. These
 * implement the same contracts the D1 adapter does, including the redemption cap
 * guard, so behaviour matches what production will do.
 *
 * Not for production: no persistence, no concurrency safety.
 */
import type { AccessEvent, AuditSink } from '../core/audit.js'
import type { AccessRequest, RequestStatus } from '../core/requests.js'
import type { GrantListOpts, GrantStore, RequestListOpts, RequestStore } from '../core/store.js'
import type { Grant } from '../core/types.js'

export interface MemoryGrantStore extends GrantStore {
  /** Live rows, for assertions the interface doesn't expose. */
  rows: Map<string, Grant>
  /** tokenHash -> grant id. */
  hashes: Map<string, string>
}

export function memoryGrantStore(): MemoryGrantStore {
  const rows = new Map<string, Grant>()
  const hashes = new Map<string, string>()

  return {
    rows,
    hashes,
    async byId(id) {
      return rows.get(id) ?? null
    },
    async byTokenHash(tokenHash) {
      const id = hashes.get(tokenHash)
      return id ? (rows.get(id) ?? null) : null
    },
    async insert(grant, tokenHash) {
      rows.set(grant.id, { ...grant })
      hashes.set(tokenHash, grant.id)
    },
    async redeem(id, nowS) {
      // Mirrors the D1 adapter's single-statement CAS, guards and all.
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
    async list(opts?: GrantListOpts) {
      return [...rows.values()]
        .filter(g => (opts?.includeRevoked || g.revokedAt === null) && (opts?.createdBy === undefined || g.createdBy === opts.createdBy))
        .sort((a, b) => b.createdAt - a.createdAt)
    },
  }
}

export interface MemoryRequestStore extends RequestStore {
  rows: Map<string, AccessRequest>
}

export function memoryRequestStore(): MemoryRequestStore {
  const rows = new Map<string, AccessRequest>()
  const ips = new Map<string, string | null>()

  return {
    rows,
    async byId(id) {
      return rows.get(id) ?? null
    },
    async pendingByEmail(email) {
      return [...rows.values()].find(r => r.email === email && r.status === 'pending') ?? null
    },
    async insert(request, ipHash) {
      rows.set(request.id, { ...request })
      ips.set(request.id, ipHash)
    },
    async decide(id, { status, decidedBy, grantId, nowS }) {
      const r = rows.get(id)
      if (!r || r.status !== 'pending') return null
      const next: AccessRequest = { ...r, status: status as RequestStatus, decidedAt: nowS, decidedBy, grantId }
      rows.set(id, next)
      return next
    },
    async list(opts?: RequestListOpts) {
      return [...rows.values()]
        .filter(r => !opts?.status || r.status === opts.status)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, opts?.limit ?? 200)
    },
    async countSince(sinceS, by) {
      return [...rows.values()].filter(
        r =>
          r.createdAt >= sinceS &&
          (by.email !== undefined ? r.email === by.email : by.ipHash != null && ips.get(r.id) === by.ipHash),
      ).length
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
