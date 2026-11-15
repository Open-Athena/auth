import { activityInteger, activityPath, activityText, checkActivityGrouping, checkActivityKind, checkActivityWrite } from '../activity/shape.js'
import { fmtGap } from '../activity/render.js'
import { ACTIVITY_LINES, ACTIVITY_SESSIONS, type ActivityBurst, type ActivityKind, type ActivityLine, type ActivityStore } from '../activity/types.js'

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
    const rows = await db.batch<BurstRow | CountRow | ActivityLine | { session_id: string }>([
      sql('SELECT * FROM activity_bursts WHERE id = ? AND purging = 0', id),
      sql(`SELECT kind, COUNT(*) AS n, SUM(notify != 'off') AS notified, SUM(record = 'line') AS lines
        FROM activity_events WHERE burst_id = ? GROUP BY kind ORDER BY kind`, id),
      sql(`SELECT id, ts, kind, line, path, session_id AS sessionId, notify FROM activity_events
        WHERE burst_id = ? AND record = 'line' ORDER BY ts DESC, id DESC LIMIT ?`, id, ACTIVITY_LINES),
      sql('SELECT session_id FROM activity_burst_sessions WHERE burst_id = ? ORDER BY rowid LIMIT ?', id, ACTIVITY_SESSIONS),
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
      sessionIds: (rows[3]!.results as { session_id: string }[]).map(r => r.session_id),
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

    async append(e, nowS, grouping) {
      checkActivityWrite(e)
      activityInteger(nowS, 'receipt time')
      const { gapS, resumeS, maxSpanS, by } = checkActivityGrouping(grouping)
      const proposed = crypto.randomUUID()
      const sid = e.sessionId ?? null
      // `by: 'session'`: a tab's events continue the burst its session started; events with no session join the actor's latest.
      const bySession = by === 'session' && sid !== null
      const latest = `SELECT id FROM activity_bursts WHERE actor_id = ? AND origin = ?${bySession ? ' AND session_key = ?' : ''} AND purging = 0
        ORDER BY last_ts DESC, id DESC LIMIT 1`
      const latestArgs = bySession ? [e.actor.id, e.origin, sid] as const : [e.actor.id, e.origin] as const
      // A burst never spans more than `maxSpanS`: past it, even steady activity starts a new one.
      const spanFloor = maxSpanS === null ? -1 : e.ts - maxSpanS
      const eligible = `SELECT id FROM activity_bursts WHERE id = (${latest}) AND last_ts BETWEEN ? AND ? AND first_ts >= ?`
      const eligibleArgs = [...latestArgs, e.ts - gapS, e.ts + gapS, spanFloor] as const
      // Past the gap, a tab's session rejoins the newest burst it was already in (within `resumeS`): one tab, one thread.
      const resumable = bySession
        ? `SELECT b.id FROM activity_bursts b WHERE b.id = (${latest}) AND b.last_ts BETWEEN ? AND ? AND b.first_ts >= ?`
        : `SELECT b.id FROM activity_bursts b JOIN activity_burst_sessions s ON s.burst_id = b.id
          WHERE s.session_id = ? AND b.actor_id = ? AND b.origin = ? AND b.purging = 0 AND b.last_ts BETWEEN ? AND ? AND b.first_ts >= ?
          ORDER BY b.last_ts DESC, b.id DESC LIMIT 1`
      const resumeArgs = bySession
        ? [...latestArgs, e.ts - resumeS, e.ts, spanFloor] as const
        : [sid, e.actor.id, e.origin, e.ts - resumeS, e.ts, spanFloor] as const
      const detailed = e.policy.record === 'line'
      // The resumption's own line says after how long: read the candidate first, and write the line only if the batch
      // still finds that same candidate (a racing append that changed the answer just loses the line, not the event).
      const resume = sid && e.resumePolicy && e.resumePolicy.record !== 'off'
        ? await sql(`SELECT b.id, b.last_ts FROM activity_bursts b WHERE b.id = (${resumable})
            AND NOT EXISTS (${eligible}) AND NOT EXISTS (SELECT 1 FROM activity_events WHERE id = ?)`,
          ...resumeArgs, ...eligibleArgs, e.id).first<{ id: string; last_ts: number }>()
        : null
      const resumePolicy = e.resumePolicy
      const statements = [
        sql(`INSERT INTO activity_bursts (id, actor_id, actor_name, via, origin, first_ts, last_ts, received_ts, session_key)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM activity_events WHERE id = ?)
          AND NOT EXISTS (${eligible}) AND NOT EXISTS (${resumable})`,
        proposed, e.actor.id, e.actor.name, e.actor.via, e.origin, e.ts, e.ts, nowS, bySession ? sid : null, e.id, ...eligibleArgs, ...resumeArgs),
        ...(resume && resumePolicy
          ? [sql(`INSERT INTO activity_events (id, burst_id, ts, kind, record, notify, line, path, session_id)
              SELECT ?, ?, ?, 'resume', ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM activity_events WHERE id = ?)
              AND NOT EXISTS (${eligible}) AND (${resumable}) = ?`,
            `${e.id}#resume`, resume.id, e.ts, resumePolicy.record, resumePolicy.notify,
            resumePolicy.record === 'line' ? `after ${fmtGap(e.ts - resume.last_ts)}` : null,
            resumePolicy.record === 'line' && e.path !== undefined ? activityPath(e.path) : null,
            resumePolicy.record === 'line' ? sid : null, e.id, ...eligibleArgs, ...resumeArgs, resume.id)]
          : []),
        sql(`INSERT INTO activity_events (id, burst_id, ts, kind, record, notify, line, path, session_id, client)
          SELECT ?, COALESCE((SELECT id FROM activity_bursts WHERE id = ?), (${eligible}), (${resumable})), ?, ?, ?, ?, ?, ?, ?, ?
          WHERE NOT EXISTS (SELECT 1 FROM activity_events WHERE id = ?)`,
        e.id, proposed, ...eligibleArgs, ...resumeArgs, e.ts, e.kind, e.policy.record, e.policy.notify,
        detailed ? (e.line ?? null) : null, detailed && e.path !== undefined ? activityPath(e.path) : null,
        detailed ? sid : null, e.client ?? null, e.id),
        // `changes()` is the receipt insert's: retries cannot change a burst, even its actor name or receipt time.
        sql(`UPDATE activity_bursts SET first_ts = MIN(first_ts, ?), last_ts = MAX(last_ts, ?),
          received_ts = MAX(received_ts, ?), actor_name = ?, via = ?, version = version + 1
          WHERE changes() = 1 AND id = (SELECT burst_id FROM activity_events WHERE id = ?)`,
        e.ts, e.ts, nowS, e.actor.name, e.actor.via, e.id),
        // Count-level kinds keep no detail, their session included.
        ...(sid && detailed
          ? [sql(`INSERT OR IGNORE INTO activity_burst_sessions (burst_id, session_id)
              SELECT burst_id, ? FROM activity_events WHERE id = ?`, sid, e.id)]
          : []),
        sql('SELECT burst_id FROM activity_events WHERE id = ?', e.id),
      ]
      const results = await db.batch<{ burst_id: string }>(statements)
      const receipt = results.at(-1)!.results[0]
      const inserted = results[resume ? 2 : 1]!
      if (!receipt) throw new Error('activity: append produced no receipt')
      return { status: inserted.meta.changes === 1 ? 'stored' : 'duplicate', burstId: receipt.burst_id }
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
      const rows = await db.batch<{ message_id: string | null; failures: number; parts: string }>([
        sql(`INSERT INTO activity_posts (burst_id, sink, claim_token, claim_until)
          SELECT b.id, ?, ?, ? FROM activity_bursts b WHERE b.id = ? AND b.purging = 0
          AND EXISTS (SELECT 1 FROM activity_events e WHERE e.burst_id = b.id AND e.notify != 'off')
          ON CONFLICT(burst_id, sink) DO UPDATE SET claim_token = excluded.claim_token, claim_until = excluded.claim_until
          WHERE activity_posts.claim_until <= ? AND activity_posts.version < (SELECT version FROM activity_bursts WHERE id = ?)` ,
        sink, token, nowS + leaseS, burstId, nowS, burstId),
        sql('SELECT message_id, failures, parts FROM activity_posts WHERE burst_id = ? AND sink = ? AND claim_token = ?', burstId, sink, token),
      ])
      const row = rows[1]!.results[0]
      return row ? { token, messageId: row.message_id, failures: row.failures, parts: JSON.parse(row.parts) as Record<string, string> } : null
    },

    async complete(burstId, sink, token, messageId, version) {
      activityText(messageId, 'message id')
      activityInteger(version, 'version', 1)
      const result = await sql(`UPDATE activity_posts SET message_id = ?, version = ?, claim_token = NULL, claim_until = 0, failures = 0
        WHERE burst_id = ? AND sink = ? AND claim_token = ? AND version < ?
        AND ? <= (SELECT version FROM activity_bursts WHERE id = ?)`,
      messageId, version, burstId, sink, token, version, version, burstId).run()
      return result.meta.changes === 1
    },

    async release(burstId, sink, token) {
      await sql(`UPDATE activity_posts SET claim_token = NULL, claim_until = 0
        WHERE burst_id = ? AND sink = ? AND claim_token = ?`, burstId, sink, token).run()
    },

    async newClients(burstId) {
      activityText(burstId, 'burst id')
      const rows = await sql(`SELECT DISTINCT e.client FROM activity_events e JOIN activity_bursts b ON b.id = e.burst_id
        WHERE e.burst_id = ? AND e.client IS NOT NULL
        AND EXISTS (SELECT 1 FROM activity_bursts p WHERE p.actor_id = b.actor_id AND p.origin = b.origin AND p.first_ts < b.first_ts)
        AND NOT EXISTS (SELECT 1 FROM activity_events o JOIN activity_bursts p ON p.id = o.burst_id
          WHERE o.client = e.client AND p.actor_id = b.actor_id AND p.origin = b.origin AND p.id != b.id AND p.first_ts < b.first_ts)
        ORDER BY e.client`, burstId).all<{ client: string }>()
      return rows.results.map(r => r.client)
    },

    async serviceRed(actorId, origin, sink) {
      const row = await sql('SELECT red FROM activity_service_state WHERE actor_id = ? AND origin = ? AND sink = ?', actorId, origin, sink).first<{ red: number }>()
      return row?.red === 1
    },

    async setServiceRed(actorId, origin, sink, red, nowS) {
      activityInteger(nowS, 'state time')
      await sql(`INSERT INTO activity_service_state (actor_id, origin, sink, red, updated_ts) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(actor_id, origin, sink) DO UPDATE SET red = excluded.red, updated_ts = excluded.updated_ts`,
      actorId, origin, sink, red ? 1 : 0, nowS).run()
    },

    async checkpoint(burstId, sink, token, messageId, parts) {
      activityText(messageId, 'message id')
      const result = await sql(`UPDATE activity_posts SET message_id = ?, parts = ?
        WHERE burst_id = ? AND sink = ? AND claim_token = ?`, messageId, JSON.stringify(parts), burstId, sink, token).run()
      return result.meta.changes === 1
    },

    async defer(burstId, sink, token, retryAtS) {
      activityInteger(retryAtS, 'retry time')
      await sql(`UPDATE activity_posts SET claim_token = NULL, claim_until = ?, failures = failures + 1
        WHERE burst_id = ? AND sink = ? AND claim_token = ?`, retryAtS, burstId, sink, token).run()
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
        sql(`DELETE FROM activity_burst_sessions WHERE rowid IN (SELECT s.rowid FROM activity_burst_sessions s JOIN activity_bursts b
          ON b.id = s.burst_id WHERE b.purging = 1 LIMIT ?)`, budget),
        sql(`DELETE FROM activity_posts WHERE rowid IN (SELECT p.rowid FROM activity_posts p JOIN activity_bursts b
          ON b.id = p.burst_id WHERE b.purging = 1 AND NOT EXISTS
          (SELECT 1 FROM activity_events e WHERE e.burst_id = b.id) LIMIT ?)`, budget),
        sql(`DELETE FROM activity_bursts WHERE id IN (SELECT b.id FROM activity_bursts b WHERE b.purging = 1
          AND NOT EXISTS (SELECT 1 FROM activity_events e WHERE e.burst_id = b.id)
          AND NOT EXISTS (SELECT 1 FROM activity_posts p WHERE p.burst_id = b.id)
          AND NOT EXISTS (SELECT 1 FROM activity_burst_sessions s WHERE s.burst_id = b.id) LIMIT ?)`, budget),
      ])
      return { events: results[1]!.meta.changes, posts: results[3]!.meta.changes, bursts: results[4]!.meta.changes }
    },
  }
}
