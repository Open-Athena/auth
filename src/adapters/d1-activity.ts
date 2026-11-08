import { activityInteger, activityPath, activityText, checkActivityKind, checkActivityWrite } from '../activity/shape.js'
import { ACTIVITY_LINES, type ActivityBurst, type ActivityKind, type ActivityLine, type ActivityStore } from '../activity/types.js'

interface BurstRow {
  id: string
  actor_id: string
  actor_name: string
  via: string
  origin: string
  first_ts: number
  last_ts: number
  received_ts: number
  version: number
}

interface CountRow { kind: string; n: number; notified: number; lines: number }

/**
 * Optional `migrations/activity/` track. All grouping/dedupe and delivery claims
 * use transactional batches, not isolate-local locks or read/modify/write JSON.
 * Use a primary/first-primary D1 session when read replication is enabled.
 */
export function d1ActivityStore(db: D1Database): ActivityStore {
  const sql = (text: string, ...args: (string | number | null)[]) => db.prepare(text).bind(...args)
  const limitValue = (value = 100) => {
    activityInteger(value, 'limit', 1)
    return Math.min(value, 500)
  }

  async function get(id: string): Promise<ActivityBurst | null> {
    activityText(id, 'burst id')
    // A coherent snapshot: its version must describe exactly these counts and lines.
    const rows = await db.batch<BurstRow | CountRow | ActivityLine>([
      sql('SELECT * FROM activity_bursts WHERE id = ? AND purging = 0', id),
      sql(`SELECT kind, COUNT(*) AS n, SUM(notify != 'off') AS notified, SUM(record = 'line') AS lines
        FROM activity_events WHERE burst_id = ? GROUP BY kind ORDER BY kind`, id),
      sql(`SELECT id, ts, kind, line, path, session_id AS sessionId, notify FROM activity_events
        WHERE burst_id = ? AND record = 'line' ORDER BY ts DESC, id DESC LIMIT ?`, id, ACTIVITY_LINES),
    ])
    const row = rows[0]!.results[0] as BurstRow | undefined
    if (!row) return null
    const counts = rows[1]!.results as CountRow[]
    const lines = (rows[2]!.results as ActivityLine[]).reverse()
    return {
      id: row.id,
      actor: { id: row.actor_id, name: row.actor_name, via: row.via },
      origin: row.origin,
      firstTs: row.first_ts,
      lastTs: row.last_ts,
      receivedTs: row.received_ts,
      version: row.version,
      counts: Object.fromEntries(counts.map(r => [r.kind, r.n])),
      notifyCounts: Object.fromEntries(counts.filter(r => r.notified > 0).map(r => [r.kind, r.notified])),
      lines,
      omittedLines: counts.reduce((n, r) => n + r.lines, 0) - lines.length,
    }
  }

  return {
    async readKinds() {
      const rows = await sql('SELECT kind, record, notify FROM activity_kinds ORDER BY kind')
        .all<ActivityKind & { kind: string }>()
      return Object.fromEntries(rows.results.map(({ kind, record, notify }) => [kind, { record, notify }]))
    },

    async writeKind(kind, policy) {
      checkActivityKind(kind, policy)
      await sql(`INSERT INTO activity_kinds (kind, record, notify) VALUES (?, ?, ?)
        ON CONFLICT(kind) DO UPDATE SET record = excluded.record, notify = excluded.notify`,
      kind, policy.record, policy.notify).run()
    },

    async append(e, nowS, gapS) {
      checkActivityWrite(e)
      activityInteger(nowS, 'receipt time')
      activityInteger(gapS, 'gap', 1)
      const proposed = crypto.randomUUID()
      const latest = `SELECT id FROM activity_bursts WHERE actor_id = ? AND origin = ? AND purging = 0
        ORDER BY last_ts DESC, id DESC LIMIT 1`
      const eligible = `SELECT id FROM activity_bursts WHERE id = (${latest}) AND last_ts BETWEEN ? AND ?`
      const eligibleArgs = [e.actor.id, e.origin, e.ts - gapS, e.ts + gapS] as const
      const detailed = e.policy.record === 'line'
      const results = await db.batch<{ burst_id: string }>([
        sql(`INSERT INTO activity_bursts (id, actor_id, actor_name, via, origin, first_ts, last_ts, received_ts)
          SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM activity_events WHERE id = ?)
          AND NOT EXISTS (${eligible})`,
        proposed, e.actor.id, e.actor.name, e.actor.via, e.origin, e.ts, e.ts, nowS, e.id, ...eligibleArgs),
        sql(`INSERT INTO activity_events (id, burst_id, ts, kind, record, notify, line, path, session_id)
          SELECT ?, COALESCE((SELECT id FROM activity_bursts WHERE id = ?), (${eligible})), ?, ?, ?, ?, ?, ?, ?
          WHERE NOT EXISTS (SELECT 1 FROM activity_events WHERE id = ?)`,
        e.id, proposed, ...eligibleArgs, e.ts, e.kind, e.policy.record, e.policy.notify,
        detailed ? (e.line ?? null) : null, detailed && e.path !== undefined ? activityPath(e.path) : null,
        detailed ? (e.sessionId ?? null) : null, e.id),
        // `changes()` is the receipt insert's: retries cannot change a burst, even its actor name or receipt time.
        sql(`UPDATE activity_bursts SET first_ts = MIN(first_ts, ?), last_ts = MAX(last_ts, ?),
          received_ts = MAX(received_ts, ?), actor_name = ?, via = ?, version = version + 1
          WHERE changes() = 1 AND id = (SELECT burst_id FROM activity_events WHERE id = ?)`,
        e.ts, e.ts, nowS, e.actor.name, e.actor.via, e.id),
        sql('SELECT burst_id FROM activity_events WHERE id = ?', e.id),
      ])
      const receipt = results[3]!.results[0]
      if (!receipt) throw new Error('activity: append produced no receipt')
      return { status: results[1]!.meta.changes === 1 ? 'stored' : 'duplicate', burstId: receipt.burst_id }
    },

    get,

    async list(filter = {}) {
      const where = ['purging = 0']
      const args: (string | number)[] = []
      if (filter.actorId !== undefined) { where.push('actor_id = ?'); args.push(filter.actorId) }
      if (filter.origin !== undefined) { where.push('origin = ?'); args.push(filter.origin) }
      if (filter.since !== undefined) {
        activityInteger(filter.since, 'since')
        where.push('last_ts >= ?'); args.push(filter.since)
      }
      const rows = await sql(`SELECT id FROM activity_bursts WHERE ${where.join(' AND ')}
        ORDER BY last_ts DESC, id DESC LIMIT ?`, ...args, limitValue(filter.limit)).all<{ id: string }>()
      const bursts: ActivityBurst[] = []
      for (const { id } of rows.results) {
        const burst = await get(id)
        if (burst) bursts.push(burst)
      }
      return bursts
    },

    async pending(sink, limit) {
      activityText(sink, 'sink id')
      const rows = await sql(`SELECT b.id FROM activity_bursts b LEFT JOIN activity_posts p
        ON p.burst_id = b.id AND p.sink = ? WHERE b.purging = 0 AND COALESCE(p.version, 0) < b.version
        AND EXISTS (SELECT 1 FROM activity_events e WHERE e.burst_id = b.id AND e.notify != 'off')
        ORDER BY b.received_ts, b.id LIMIT ?`, sink, limitValue(limit)).all<{ id: string }>()
      return rows.results.map(r => r.id)
    },

    async claim(burstId, sink, nowS, leaseS) {
      activityText(burstId, 'burst id')
      activityText(sink, 'sink id')
      activityInteger(nowS, 'claim time')
      activityInteger(leaseS, 'lease', 1)
      activityInteger(nowS + leaseS, 'lease end')
      const token = crypto.randomUUID()
      const rows = await db.batch<{ message_id: string | null }>([
        sql(`INSERT INTO activity_posts (burst_id, sink, claim_token, claim_until)
          SELECT b.id, ?, ?, ? FROM activity_bursts b WHERE b.id = ? AND b.purging = 0
          AND EXISTS (SELECT 1 FROM activity_events e WHERE e.burst_id = b.id AND e.notify != 'off')
          ON CONFLICT(burst_id, sink) DO UPDATE SET claim_token = excluded.claim_token, claim_until = excluded.claim_until
          WHERE activity_posts.claim_until <= ? AND activity_posts.version < (SELECT version FROM activity_bursts WHERE id = ?)` ,
        sink, token, nowS + leaseS, burstId, nowS, burstId),
        sql('SELECT message_id FROM activity_posts WHERE burst_id = ? AND sink = ? AND claim_token = ?', burstId, sink, token),
      ])
      const row = rows[1]!.results[0]
      return row ? { token, messageId: row.message_id } : null
    },

    async complete(burstId, sink, token, messageId, version) {
      activityText(messageId, 'message id')
      activityInteger(version, 'version', 1)
      const result = await sql(`UPDATE activity_posts SET message_id = ?, version = ?, claim_token = NULL, claim_until = 0
        WHERE burst_id = ? AND sink = ? AND claim_token = ? AND version < ?
        AND ? <= (SELECT version FROM activity_bursts WHERE id = ?)`,
      messageId, version, burstId, sink, token, version, version, burstId).run()
      return result.meta.changes === 1
    },

    async release(burstId, sink, token) {
      await sql(`UPDATE activity_posts SET claim_token = NULL, claim_until = 0
        WHERE burst_id = ? AND sink = ? AND claim_token = ?`, burstId, sink, token).run()
    },

    async purge(cutoffS, nowS, limit = 200) {
      activityInteger(cutoffS, 'cutoff')
      activityInteger(nowS, 'purge time')
      const budget = limitValue(limit)
      const results = await db.batch([
        // Mark first so concurrent ingestion starts a new burst and delivery cannot read a half-purged snapshot.
        sql(`UPDATE activity_bursts SET purging = 1 WHERE id IN (SELECT b.id FROM activity_bursts b
          WHERE b.purging = 0 AND b.received_ts < ? AND NOT EXISTS (SELECT 1 FROM activity_posts p
            WHERE p.burst_id = b.id AND p.claim_until > ?) ORDER BY b.received_ts, b.id LIMIT ?)`, cutoffS, nowS, budget),
        sql(`DELETE FROM activity_events WHERE id IN (SELECT e.id FROM activity_events e JOIN activity_bursts b
          ON b.id = e.burst_id WHERE b.purging = 1 ORDER BY e.id LIMIT ?)`, budget),
        sql(`DELETE FROM activity_posts WHERE rowid IN (SELECT p.rowid FROM activity_posts p JOIN activity_bursts b
          ON b.id = p.burst_id WHERE b.purging = 1 AND NOT EXISTS
          (SELECT 1 FROM activity_events e WHERE e.burst_id = b.id) LIMIT ?)`, budget),
        sql(`DELETE FROM activity_bursts WHERE id IN (SELECT b.id FROM activity_bursts b WHERE b.purging = 1
          AND NOT EXISTS (SELECT 1 FROM activity_events e WHERE e.burst_id = b.id)
          AND NOT EXISTS (SELECT 1 FROM activity_posts p WHERE p.burst_id = b.id) LIMIT ?)`, budget),
      ])
      return { events: results[1]!.meta.changes, posts: results[2]!.meta.changes, bursts: results[3]!.meta.changes }
    },
  }
}
