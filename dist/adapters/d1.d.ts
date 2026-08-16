/**
 * D1 (Cloudflare's SQLite) adapter — a file boundary, not an abstraction layer.
 * Row I/O plus the one piece of logic that must be SQL: the atomic redeem CAS.
 * Any other SQLite (Turso, better-sqlite3) or Postgres backend is a sibling
 * file of about this size; nothing here needs a plugin registry to swap.
 *
 * Apply `migrations/0001_grants.sql` and `migrations/0002_access_log.sql` first.
 */
import type { AuditSink } from '../core/audit.js';
import type { AuditQuery, GrantStore, RequestStore } from '../core/store.js';
export declare function d1GrantStore(db: D1Database): GrantStore;
export declare function d1RequestStore(db: D1Database): RequestStore;
export interface RollupResult {
    /** Raw rows collapsed and removed. */
    rolledUp: number;
    /** Daily buckets written or incremented. */
    buckets: number;
    /** Rows at or after this timestamp were left alone. */
    cutoff: number;
}
/**
 * Collapse raw `access_log` rows older than `olderThanDays` into daily buckets,
 * then delete them. Idempotent: re-running produces the same table, because the
 * upsert adds to existing buckets and the source rows are gone.
 *
 * Schedule it from a Worker cron (Pages Functions have no scheduler of their
 * own) or call it from an admin route. Retention is the other thing a hosted
 * analytics tool does for you; a first-party log has to do it deliberately.
 */
export declare function rollupAccessLog(db: D1Database, { olderThanDays, nowS }?: {
    olderThanDays?: number;
    nowS?: number;
}): Promise<RollupResult>;
/**
 * Read side of the access log. This is what turns rows into the sentence the
 * admin view exists to say: "Bob's link: redeemed 4 times from 2 countries,
 * last seen 2h ago, 37 views, mostly /finances/2025."
 */
export declare function d1AuditQuery(db: D1Database): AuditQuery;
/**
 * Access-log sink. `view` rows carry an hour bucket and hit a partial unique
 * index, so the per-(session, path, hour) dedupe is enforced by the DB rather
 * than by a read-then-write race in the worker.
 */
export declare function d1AuditSink(db: D1Database): AuditSink;
