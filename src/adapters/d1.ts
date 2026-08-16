/**
 * D1 (Cloudflare's SQLite) adapter — a file boundary, not an abstraction layer.
 * Row I/O plus the one piece of logic that must be SQL: the atomic redeem CAS.
 * Any other SQLite (Turso, better-sqlite3) or Postgres backend is a sibling
 * file of about this size; nothing here needs a plugin registry to swap.
 *
 * Apply `migrations/0001_grants.sql` and `migrations/0002_access_log.sql` first.
 */
import type { AccessEvent, AuditSink } from '../core/audit.js'
import type { GrantStore } from '../core/store.js'
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
      const where = opts?.includeRevoked ? '' : 'WHERE revoked_at IS NULL'
      const { results } = await db.prepare(`SELECT ${COLS} FROM grants ${where} ORDER BY created_at DESC`).all<GrantRow>()
      return results.map(toGrant)
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
