/**
 * D1 (Cloudflare's SQLite) adapter — a file boundary, not an abstraction layer.
 * Row I/O plus the one piece of logic that must be SQL: the atomic redeem CAS.
 * Any other SQLite (Turso, better-sqlite3) or Postgres backend is a sibling
 * file of about this size; nothing here needs a plugin registry to swap.
 *
 * Apply `migrations/0001_grants.sql` and `migrations/0002_access_log.sql` first.
 */
import type { AccessEvent, AuditSink } from '../core/audit.js'
import type { AccessRequest, RequestStatus } from '../core/requests.js'
import type { AuditQuery, GrantStore, RequestStore } from '../core/store.js'
import { type Grant, type Subject, formatScopes, parseScopes } from '../core/types.js'

interface GrantRow {
  id: string
  name: string | null
  note: string | null
  subject_json: string | null
  email: string | null
  scopes: string
  max_redeems: number | null
  redeems: number
  expires_at: number | null
  session_ttl: number | null
  created_at: number
  created_by: string
  revoked_at: number | null
  first_used_at: number | null
  last_used_at: number | null
}

const COLS =
  'id, name, note, subject_json, email, scopes, max_redeems, redeems, expires_at, session_ttl, created_at, created_by, revoked_at, first_used_at, last_used_at'

function parseSubject(json: string | null): Subject | null {
  if (!json) return null
  try {
    return JSON.parse(json) as Subject
  } catch {
    // A malformed blob is cosmetic (it only feeds greeting/watermark copy);
    // failing the whole auth check over it would be the wrong trade.
    return null
  }
}

const toGrant = (r: GrantRow): Grant => ({
  id: r.id,
  name: r.name,
  note: r.note,
  subject: parseSubject(r.subject_json),
  email: r.email,
  scopes: parseScopes(r.scopes),
  maxRedeems: r.max_redeems,
  redeems: r.redeems,
  expiresAt: r.expires_at,
  sessionTtlS: r.session_ttl,
  createdAt: r.created_at,
  createdBy: r.created_by,
  revokedAt: r.revoked_at,
  firstUsedAt: r.first_used_at,
  lastUsedAt: r.last_used_at,
})

export function d1GrantStore(db: D1Database): GrantStore {
  return {
    async byId(id) {
      const row = await db.prepare(`SELECT ${COLS} FROM grants WHERE id = ?`).bind(id).first<GrantRow>()
      return row ? toGrant(row) : null
    },

    async byTokenHash(tokenHash) {
      const row = await db.prepare(`SELECT ${COLS} FROM grants WHERE token_hash = ?`).bind(tokenHash).first<GrantRow>()
      return row ? toGrant(row) : null
    },

    async insert(g, tokenHash) {
      await db
        .prepare(
          `INSERT INTO grants (id, token_hash, name, note, subject_json, email, scopes, max_redeems, redeems,
                               expires_at, session_ttl, created_at, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
        )
        .bind(
          g.id,
          tokenHash,
          g.name,
          g.note,
          g.subject ? JSON.stringify(g.subject) : null,
          g.email,
          formatScopes(g.scopes),
          g.maxRedeems,
          g.expiresAt,
          g.sessionTtlS,
          g.createdAt,
          g.createdBy,
        )
        .run()
    },

    async redeem(id, nowS) {
      // Single-statement CAS: the cap, expiry and revocation guards are in the
      // WHERE clause, so two simultaneous opens of a max_redeems:1 link can't
      // both pass. RETURNING gives us the post-increment row for free.
      const row = await db
        .prepare(
          `UPDATE grants
              SET redeems = redeems + 1,
                  first_used_at = COALESCE(first_used_at, ?),
                  last_used_at = ?
            WHERE id = ?
              AND revoked_at IS NULL
              AND (expires_at IS NULL OR expires_at > ?)
              AND (max_redeems IS NULL OR redeems < max_redeems)
            RETURNING ${COLS}`,
        )
        .bind(nowS, nowS, id, nowS)
        .first<GrantRow>()
      return row ? toGrant(row) : null
    },

    async touch(id, nowS, minIntervalS) {
      await db
        .prepare(`UPDATE grants SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)`)
        .bind(nowS, id, nowS - minIntervalS)
        .run()
    },

    async revoke(id, nowS) {
      const res = await db.prepare(`UPDATE grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`).bind(nowS, id).run()
      return (res.meta?.changes ?? 0) > 0
    },

    async list(opts) {
      const where: string[] = []
      const binds: unknown[] = []
      if (!opts?.includeRevoked) where.push('revoked_at IS NULL')
      if (opts?.createdBy !== undefined) {
        where.push('created_by = ?')
        binds.push(opts.createdBy)
      }
      const { results } = await db
        .prepare(`SELECT ${COLS} FROM grants ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC`)
        .bind(...binds)
        .all<GrantRow>()
      return results.map(toGrant)
    },
  }
}

interface RequestRow {
  id: string
  email: string
  name: string | null
  note: string | null
  created_at: number
  status: RequestStatus
  decided_at: number | null
  decided_by: string | null
  grant_id: string | null
}

const REQ_COLS = 'id, email, name, note, created_at, status, decided_at, decided_by, grant_id'

const toRequest = (r: RequestRow): AccessRequest => ({
  id: r.id,
  email: r.email,
  name: r.name,
  note: r.note,
  createdAt: r.created_at,
  status: r.status,
  decidedAt: r.decided_at,
  decidedBy: r.decided_by,
  grantId: r.grant_id,
})

export function d1RequestStore(db: D1Database): RequestStore {
  return {
    async byId(id) {
      const row = await db.prepare(`SELECT ${REQ_COLS} FROM access_requests WHERE id = ?`).bind(id).first<RequestRow>()
      return row ? toRequest(row) : null
    },

    async pendingByEmail(email) {
      const row = await db
        .prepare(`SELECT ${REQ_COLS} FROM access_requests WHERE email = ? AND status = 'pending'`)
        .bind(email)
        .first<RequestRow>()
      return row ? toRequest(row) : null
    },

    async insert(r, ipHash) {
      await db
        .prepare(
          `INSERT INTO access_requests (id, email, name, note, created_at, status, decided_at, decided_by, grant_id, ip_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(r.id, r.email, r.name, r.note, r.createdAt, r.status, r.decidedAt, r.decidedBy, r.grantId, ipHash)
        .run()
    },

    async decide(id, { status, decidedBy, grantId, nowS }) {
      // Guarded on `status = 'pending'`, so two admins clicking approve at once
      // produce one decision rather than two grants and a lost update.
      const row = await db
        .prepare(
          `UPDATE access_requests SET status = ?, decided_at = ?, decided_by = ?, grant_id = ?
            WHERE id = ? AND status = 'pending'
            RETURNING ${REQ_COLS}`,
        )
        .bind(status, nowS, decidedBy, grantId, id)
        .first<RequestRow>()
      return row ? toRequest(row) : null
    },

    async list(opts) {
      const where = opts?.status ? 'WHERE status = ?' : ''
      const binds = opts?.status ? [opts.status] : []
      const { results } = await db
        .prepare(`SELECT ${REQ_COLS} FROM access_requests ${where} ORDER BY created_at DESC LIMIT ?`)
        .bind(...binds, opts?.limit ?? 200)
        .all<RequestRow>()
      return results.map(toRequest)
    },

    async countSince(sinceS, by) {
      const col = by.email !== undefined ? 'email' : 'ip_hash'
      const value = by.email ?? by.ipHash
      if (value == null) return 0
      const row = await db
        .prepare(`SELECT COUNT(*) AS n FROM access_requests WHERE ${col} = ? AND created_at >= ?`)
        .bind(value, sinceS)
        .first<{ n: number }>()
      return row?.n ?? 0
    },
  }
}

/**
 * Read side of the access log. This is what turns rows into the sentence the
 * admin view exists to say: "Bob's link: redeemed 4 times from 2 countries,
 * last seen 2h ago, 37 views, mostly /finances/2025."
 */
export function d1AuditQuery(db: D1Database): AuditQuery {
  return {
    async activity(grantId) {
      const summary = await db
        .prepare(
          `SELECT COUNT(DISTINCT ip_hash) AS ips,
                  SUM(CASE WHEN event = 'view' THEN 1 ELSE 0 END) AS views,
                  MIN(ts) AS first_seen,
                  MAX(ts) AS last_seen
             FROM access_log WHERE grant_id = ?`,
        )
        .bind(grantId)
        .first<{ ips: number; views: number | null; first_seen: number | null; last_seen: number | null }>()
      const countries = await db
        .prepare(`SELECT DISTINCT country FROM access_log WHERE grant_id = ? AND country IS NOT NULL ORDER BY country`)
        .bind(grantId)
        .all<{ country: string }>()
      const paths = await db
        .prepare(
          `SELECT path, COUNT(*) AS views FROM access_log
            WHERE grant_id = ? AND event = 'view' AND path IS NOT NULL
            GROUP BY path ORDER BY views DESC, path LIMIT 5`,
        )
        .bind(grantId)
        .all<{ path: string; views: number }>()
      return {
        grantId,
        distinctIps: summary?.ips ?? 0,
        countries: countries.results.map(r => r.country),
        views: summary?.views ?? 0,
        firstSeen: summary?.first_seen ?? null,
        lastSeen: summary?.last_seen ?? null,
        topPaths: paths.results,
      }
    },

    async recent(opts) {
      const where: string[] = []
      const binds: unknown[] = []
      if (opts?.grantId) {
        where.push('l.grant_id = ?')
        binds.push(opts.grantId)
      }
      // Scope an admin to their own links (the demo's per-visitor sandbox).
      const join = opts?.createdBy === undefined ? '' : 'JOIN grants g ON g.id = l.grant_id'
      if (opts?.createdBy !== undefined) {
        where.push('g.created_by = ?')
        binds.push(opts.createdBy)
      }
      const { results } = await db
        .prepare(
          `SELECT l.id, l.ts, l.event, l.grant_id, l.session_sub, l.path, l.reason, l.country
             FROM access_log l ${join}
             ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
            ORDER BY l.id DESC LIMIT ?`,
        )
        .bind(...binds, opts?.limit ?? 100)
        .all<{
          id: number
          ts: number
          event: string
          grant_id: string | null
          session_sub: string | null
          path: string | null
          reason: string | null
          country: string | null
        }>()
      return results.map(r => ({
        id: r.id,
        ts: r.ts,
        event: r.event,
        grantId: r.grant_id,
        sessionSub: r.session_sub,
        path: r.path,
        reason: r.reason,
        country: r.country,
      }))
    },
  }
}

/**
 * Access-log sink. `view` rows carry an hour bucket and hit a partial unique
 * index, so the per-(session, path, hour) dedupe is enforced by the DB rather
 * than by a read-then-write race in the worker.
 */
export function d1AuditSink(db: D1Database): AuditSink {
  return {
    async log(e: AccessEvent) {
      const bucket = e.event === 'view' ? Math.floor(e.ts / 3600) : null
      await db
        .prepare(
          `INSERT INTO access_log (ts, event, grant_id, session_sub, path, status, ip_hash, ua, country, referer, reason, bucket)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT DO NOTHING`,
        )
        .bind(
          e.ts,
          e.event,
          e.grantId ?? null,
          e.sessionSub ?? null,
          e.path ?? null,
          e.status ?? null,
          e.ipHash ?? null,
          e.ua ?? null,
          e.country ?? null,
          e.referer ?? null,
          e.reason ?? null,
          bucket,
        )
        .run()
    },
  }
}
