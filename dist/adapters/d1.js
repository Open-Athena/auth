import { formatScopes, parseScopes } from '../core/types.js';
const COLS = 'id, name, note, subject_json, email, scopes, max_redeems, redeems, expires_at, session_ttl, created_at, created_by, revoked_at, first_used_at, last_used_at';
function parseSubject(json) {
    if (!json)
        return null;
    try {
        return JSON.parse(json);
    }
    catch {
        // A malformed blob is cosmetic (it only feeds greeting/watermark copy);
        // failing the whole auth check over it would be the wrong trade.
        return null;
    }
}
const toGrant = (r) => ({
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
});
export function d1GrantStore(db) {
    return {
        async byId(id) {
            const row = await db.prepare(`SELECT ${COLS} FROM grants WHERE id = ?`).bind(id).first();
            return row ? toGrant(row) : null;
        },
        async byTokenHash(tokenHash) {
            const row = await db.prepare(`SELECT ${COLS} FROM grants WHERE token_hash = ?`).bind(tokenHash).first();
            return row ? toGrant(row) : null;
        },
        async insert(g, tokenHash) {
            await db
                .prepare(`INSERT INTO grants (id, token_hash, name, note, subject_json, email, scopes, max_redeems, redeems,
                               expires_at, session_ttl, created_at, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`)
                .bind(g.id, tokenHash, g.name, g.note, g.subject ? JSON.stringify(g.subject) : null, g.email, formatScopes(g.scopes), g.maxRedeems, g.expiresAt, g.sessionTtlS, g.createdAt, g.createdBy)
                .run();
        },
        async redeem(id, nowS) {
            // Single-statement CAS: the cap, expiry and revocation guards are in the
            // WHERE clause, so two simultaneous opens of a max_redeems:1 link can't
            // both pass. RETURNING gives us the post-increment row for free.
            const row = await db
                .prepare(`UPDATE grants
              SET redeems = redeems + 1,
                  first_used_at = COALESCE(first_used_at, ?),
                  last_used_at = ?
            WHERE id = ?
              AND revoked_at IS NULL
              AND (expires_at IS NULL OR expires_at > ?)
              AND (max_redeems IS NULL OR redeems < max_redeems)
            RETURNING ${COLS}`)
                .bind(nowS, nowS, id, nowS)
                .first();
            return row ? toGrant(row) : null;
        },
        async touch(id, nowS, minIntervalS) {
            await db
                .prepare(`UPDATE grants SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)`)
                .bind(nowS, id, nowS - minIntervalS)
                .run();
        },
        async revoke(id, nowS) {
            const res = await db.prepare(`UPDATE grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`).bind(nowS, id).run();
            return (res.meta?.changes ?? 0) > 0;
        },
        async list(opts) {
            const where = [];
            const binds = [];
            if (!opts?.includeRevoked)
                where.push('revoked_at IS NULL');
            if (opts?.createdBy !== undefined) {
                where.push('created_by = ?');
                binds.push(opts.createdBy);
            }
            const { results } = await db
                .prepare(`SELECT ${COLS} FROM grants ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC`)
                .bind(...binds)
                .all();
            return results.map(toGrant);
        },
    };
}
const REQ_COLS = 'id, email, name, note, created_at, status, decided_at, decided_by, grant_id';
const toRequest = (r) => ({
    id: r.id,
    email: r.email,
    name: r.name,
    note: r.note,
    createdAt: r.created_at,
    status: r.status,
    decidedAt: r.decided_at,
    decidedBy: r.decided_by,
    grantId: r.grant_id,
});
export function d1RequestStore(db) {
    return {
        async byId(id) {
            const row = await db.prepare(`SELECT ${REQ_COLS} FROM access_requests WHERE id = ?`).bind(id).first();
            return row ? toRequest(row) : null;
        },
        async pendingByEmail(email) {
            const row = await db
                .prepare(`SELECT ${REQ_COLS} FROM access_requests WHERE email = ? AND status = 'pending'`)
                .bind(email)
                .first();
            return row ? toRequest(row) : null;
        },
        async insert(r, ipHash) {
            await db
                .prepare(`INSERT INTO access_requests (id, email, name, note, created_at, status, decided_at, decided_by, grant_id, ip_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .bind(r.id, r.email, r.name, r.note, r.createdAt, r.status, r.decidedAt, r.decidedBy, r.grantId, ipHash)
                .run();
        },
        async decide(id, { status, decidedBy, grantId, nowS }) {
            // Guarded on `status = 'pending'`, so two admins clicking approve at once
            // produce one decision rather than two grants and a lost update.
            const row = await db
                .prepare(`UPDATE access_requests SET status = ?, decided_at = ?, decided_by = ?, grant_id = ?
            WHERE id = ? AND status = 'pending'
            RETURNING ${REQ_COLS}`)
                .bind(status, nowS, decidedBy, grantId, id)
                .first();
            return row ? toRequest(row) : null;
        },
        async list(opts) {
            const where = opts?.status ? 'WHERE status = ?' : '';
            const binds = opts?.status ? [opts.status] : [];
            const { results } = await db
                .prepare(`SELECT ${REQ_COLS} FROM access_requests ${where} ORDER BY created_at DESC LIMIT ?`)
                .bind(...binds, opts?.limit ?? 200)
                .all();
            return results.map(toRequest);
        },
        async countSince(sinceS, by) {
            const col = by.email !== undefined ? 'email' : 'ip_hash';
            const value = by.email ?? by.ipHash;
            if (value == null)
                return 0;
            const row = await db
                .prepare(`SELECT COUNT(*) AS n FROM access_requests WHERE ${col} = ? AND created_at >= ?`)
                .bind(value, sinceS)
                .first();
            return row?.n ?? 0;
        },
    };
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
export async function rollupAccessLog(db, { olderThanDays = 90, nowS = Math.floor(Date.now() / 1000) } = {}) {
    const cutoff = nowS - olderThanDays * 86400;
    const before = await db
        .prepare(`SELECT COUNT(*) AS n FROM access_log WHERE ts < ?`)
        .bind(cutoff)
        .first();
    if (!before?.n)
        return { rolledUp: 0, buckets: 0, cutoff };
    // COALESCE the grouping keys: SQLite treats NULLs as distinct in a PRIMARY
    // KEY, so without it every NULL-path row would get its own bucket and the
    // upsert would never merge.
    const upsert = await db
        .prepare(`INSERT INTO access_log_daily (day, event, grant_id, path, country, events, clients)
       SELECT ts / 86400,
              event,
              COALESCE(grant_id, ''),
              COALESCE(path, ''),
              COALESCE(country, ''),
              COUNT(*),
              COUNT(DISTINCT ip_hash)
         FROM access_log
        WHERE ts < ?
        GROUP BY ts / 86400, event, COALESCE(grant_id, ''), COALESCE(path, ''), COALESCE(country, '')
       ON CONFLICT (day, event, grant_id, path, country) DO UPDATE SET
              events = events + excluded.events,
              clients = MAX(clients, excluded.clients)`)
        .bind(cutoff)
        .run();
    await db.prepare(`DELETE FROM access_log WHERE ts < ?`).bind(cutoff).run();
    return { rolledUp: before.n, buckets: upsert.meta?.changes ?? 0, cutoff };
}
/**
 * Read side of the access log. This is what turns rows into the sentence the
 * admin view exists to say: "Bob's link: redeemed 4 times from 2 countries,
 * last seen 2h ago, 37 views, mostly /finances/2025."
 */
export function d1AuditQuery(db) {
    return {
        async activity(grantId) {
            const summary = await db
                .prepare(`SELECT COUNT(DISTINCT ip_hash) AS ips,
                  SUM(CASE WHEN event = 'view' THEN 1 ELSE 0 END) AS views,
                  MIN(ts) AS first_seen,
                  MAX(ts) AS last_seen
             FROM access_log WHERE grant_id = ?`)
                .bind(grantId)
                .first();
            const countries = await db
                .prepare(`SELECT DISTINCT country FROM access_log WHERE grant_id = ? AND country IS NOT NULL ORDER BY country`)
                .bind(grantId)
                .all();
            const paths = await db
                .prepare(`SELECT path, COUNT(*) AS views FROM access_log
            WHERE grant_id = ? AND event = 'view' AND path IS NOT NULL
            GROUP BY path ORDER BY views DESC, path LIMIT 5`)
                .bind(grantId)
                .all();
            return {
                grantId,
                distinctIps: summary?.ips ?? 0,
                countries: countries.results.map(r => r.country),
                views: summary?.views ?? 0,
                firstSeen: summary?.first_seen ?? null,
                lastSeen: summary?.last_seen ?? null,
                topPaths: paths.results,
            };
        },
        async recent(opts) {
            const where = [];
            const binds = [];
            if (opts?.grantId) {
                where.push('l.grant_id = ?');
                binds.push(opts.grantId);
            }
            // Scope an admin to their own links (the demo's per-visitor sandbox).
            const join = opts?.createdBy === undefined ? '' : 'JOIN grants g ON g.id = l.grant_id';
            if (opts?.createdBy !== undefined) {
                where.push('g.created_by = ?');
                binds.push(opts.createdBy);
            }
            const { results } = await db
                .prepare(`SELECT l.id, l.ts, l.event, l.grant_id, l.session_sub, l.path, l.reason, l.country
             FROM access_log l ${join}
             ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
            ORDER BY l.id DESC LIMIT ?`)
                .bind(...binds, opts?.limit ?? 100)
                .all();
            return results.map(r => ({
                id: r.id,
                ts: r.ts,
                event: r.event,
                grantId: r.grant_id,
                sessionSub: r.session_sub,
                path: r.path,
                reason: r.reason,
                country: r.country,
            }));
        },
    };
}
/**
 * Access-log sink. `view` rows carry an hour bucket and hit a partial unique
 * index, so the per-(session, path, hour) dedupe is enforced by the DB rather
 * than by a read-then-write race in the worker.
 */
export function d1AuditSink(db) {
    return {
        async log(e) {
            // Dedupe per (event, session, path, hour) for chatty-but-uninformative
            // repeats: `view` rows, and `deny` rows from a session we can already
            // name — a revoked link's browser re-denies on every page load, and the
            // second row through the tenth tell you nothing the first didn't.
            //
            // A deny with no `session_sub` came from a *presented token*, not a known
            // session. Those always land: repeated bad tokens are someone probing,
            // which is exactly the signal the log exists to keep.
            const dedupe = e.event === 'view' || (e.event === 'deny' && !!e.sessionSub);
            const bucket = dedupe ? Math.floor(e.ts / 3600) : null;
            await db
                .prepare(`INSERT INTO access_log (ts, event, grant_id, session_sub, path, status, ip_hash, ua, country, referer, reason, bucket)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT DO NOTHING`)
                .bind(e.ts, e.event, e.grantId ?? null, e.sessionSub ?? null, e.path ?? null, e.status ?? null, e.ipHash ?? null, e.ua ?? null, e.country ?? null, e.referer ?? null, e.reason ?? null, bucket)
                .run();
        },
    };
}
