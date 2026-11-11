/**
 * The session log's D1 store. Tables: `session_log` (one row per session),
 * `session_log_batches` (one row per client flush, events as a JSON array) and
 * `session_log_switch` (one row), from `migrations/session-log/` — a track of
 * its own, applied only where the session log is mounted.
 */
import {
  type Cursor,
  fmtCursor,
  isErrorEvent,
  LIMITS,
  type SessionDetail,
  type SessionPage,
  type SessionRow,
  SESSIONS_MAX_LIMIT,
  SESSIONS_PAGE,
  type SlogEvent,
  type StoredEvent,
} from '../core/session-log-shape.js'
import { type SessionFilter, SessionLogNotSetUp, type SessionLogStore, type SwitchRow } from '../session-log/store.js'

export interface D1SessionLogOptions {
  /** Rows one purge statement deletes (default 500). */
  purgeChunk?: number
  /** Statements per table per `purge` call (default 20): a call deletes at most `purgeChunk × purgeChunks` rows a table. */
  purgeChunks?: number
}

const missingTable = (e: unknown): boolean => /no such table/.test(String((e as Error)?.message))

/** Run `fn`, distinguishing a missing track from an unapplied actor migration. */
async function tables<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (missingTable(e)) throw new SessionLogNotSetUp()
    if (/(?:no such column:\s*(?:session_log\.)?|has no column named\s*)(?:grant_id|subject_name)\b/i.test(String((e as Error)?.message))) {
      throw new Error('session log schema is outdated: apply migrations/session-log/0002_actor.sql', { cause: e })
    }
    throw e
  }
}

const firstUrl = (events: SlogEvent[]): string | null => {
  const e = events.find(x => x.k === 'start' || x.k === 'nav')
  return typeof e?.u === 'string' ? e.u : null
}

/** Rows strictly ahead of a cursor in the list's order (`last_ms` desc, `sid` asc). */
const AHEAD = '(last_ms > ? OR (last_ms = ? AND sid < ?))'
/** Rows strictly behind it. */
const BEHIND = '(last_ms < ? OR (last_ms = ? AND sid > ?))'
const keyArgs = (c: Cursor): unknown[] => [c.lastMs, c.lastMs, c.sid]
const whereSql = (w: string[]): string => (w.length ? ` WHERE ${w.join(' AND ')}` : '')

const SESSION_COLUMNS = 'sid, email, via, build, ua, started_ms, last_ms, n_events, n_errors, n_batches, first_url, received_ts, grant_id, subject_name'
type StoredSessionRow = Omit<SessionRow, 'grant_id' | 'subject_name'> & { grant_id: string | null; subject_name: string | null }

/** Keep absent actor fields out of the wire shape, preserving older JSON fixtures. */
function sessionRow({ grant_id, subject_name, ...row }: StoredSessionRow): SessionRow {
  return { ...row, ...(grant_id === null ? {} : { grant_id }), ...(subject_name === null ? {} : { subject_name }) }
}

function filterSql(f: SessionFilter): { where: string[]; args: unknown[] } {
  const where: string[] = []
  const args: unknown[] = []
  if (f.email) {
    where.push("(LOWER(COALESCE(email, '')) LIKE ? OR LOWER(COALESCE(subject_name, '')) LIKE ? OR LOWER(COALESCE(grant_id, '')) LIKE ?)")
    const pattern = `%${f.email.toLowerCase()}%`
    args.push(pattern, pattern, pattern)
  }
  if (f.since !== undefined) {
    where.push('last_ms >= ?')
    args.push(f.since)
  }
  if (f.errors) where.push('n_errors > 0')
  return { where, args }
}

export function d1SessionLogStore(db: D1Database, opts: D1SessionLogOptions = {}): SessionLogStore {
  const { purgeChunk = 500, purgeChunks = 20 } = opts

  async function deleteOld(table: string, cutoffS: number): Promise<number> {
    let n = 0
    for (let i = 0; i < purgeChunks; i++) {
      const r = await db
        .prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE received_ts < ? LIMIT ?)`)
        .bind(cutoffS, purgeChunk)
        .run()
      const changed = r.meta.changes ?? 0
      n += changed
      if (changed < purgeChunk) break
    }
    return n
  }

  return {
    ingest: (who, ua, b, nowS) =>
      tables(async () => {
        const prior = await db
          .prepare('SELECT n_events FROM session_log WHERE sid = ?')
          .bind(b.sid)
          .first<{ n_events: number }>()
        if (prior && prior.n_events + b.events.length > LIMITS.sessionEvents) return 'capped'
        const ts = b.events.map(e => e.t)
        const first = Math.min(...ts)
        const last = Math.max(...ts)
        const errors = b.events.filter(e => isErrorEvent(e, nowS * 1000)).length
        // One transaction: the batch row, then the session's counters only if
        // that row was new (`changes()`), so a retried beacon counts nothing and
        // a failure leaves neither half behind.
        const [ins] = await db.batch([
          db
            .prepare(
              `INSERT OR IGNORE INTO session_log_batches (sid, pid, seq, received_ts, first_ms, last_ms, n, events)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(b.sid, b.pid, b.seq, nowS, first, last, b.events.length, JSON.stringify(b.events)),
          db
            .prepare(
              `INSERT INTO session_log (sid, email, via, build, ua, started_ms, last_ms, n_events, n_errors, n_batches, first_url, received_ts, grant_id, subject_name)
               SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1, ?10, ?11, ?12, ?13 WHERE changes() > 0
               ON CONFLICT (sid) DO UPDATE SET
                 email = excluded.email, via = excluded.via, build = excluded.build,
                 grant_id = excluded.grant_id, subject_name = excluded.subject_name,
                 ua = COALESCE(excluded.ua, ua),
                 started_ms = MIN(started_ms, excluded.started_ms), last_ms = MAX(last_ms, excluded.last_ms),
                 n_events = n_events + excluded.n_events, n_errors = n_errors + excluded.n_errors,
                 n_batches = n_batches + 1,
                 first_url = COALESCE(first_url, excluded.first_url), received_ts = excluded.received_ts`,
            )
            .bind(
              b.sid,
              who.email,
              who.via,
              b.build || null,
              ua ? ua.slice(0, 300) : null,
              first,
              last,
              b.events.length,
              errors,
              firstUrl(b.events),
              nowS,
              who.grantId ?? null,
              who.subjectName ?? null,
            ),
        ])
        return ins?.meta.changes ? 'stored' : 'duplicate'
      }),

    async purge(cutoffS) {
      try {
        const batches = await deleteOld('session_log_batches', cutoffS)
        const sessions = await deleteOld('session_log', cutoffS)
        return { batches, sessions }
      } catch (e) {
        if (missingTable(e)) return null
        throw e
      }
    },

    async readSwitch() {
      try {
        return await db.prepare('SELECT until_ms, who, ts FROM session_log_switch WHERE id = 1').first<SwitchRow>()
      } catch (e) {
        if (missingTable(e)) return 'missing'
        throw e
      }
    },

    writeSwitch: (untilMs, who, nowS) =>
      tables(async () => {
        const prior = await db.prepare('SELECT until_ms, who, ts FROM session_log_switch WHERE id = 1').first<SwitchRow>()
        const row: SwitchRow = { until_ms: untilMs, who, ts: nowS }
        await db
          .prepare(
            `INSERT INTO session_log_switch (id, until_ms, who, ts) VALUES (1, ?, ?, ?)
             ON CONFLICT (id) DO UPDATE SET until_ms = excluded.until_ms, who = excluded.who, ts = excluded.ts`,
          )
          .bind(untilMs, who, nowS)
          .run()
        return { prior: prior ?? null, row }
      }),

    /**
     * One page, most recently active first (ties by `sid`), by keyset on
     * `(last_ms, sid)`: `after` reads the rows behind the cursor, `before` the
     * nearest rows ahead of it (read in reverse, then flipped). A `before` page
     * that comes up short is at the head, so it is answered as the first page.
     * `total` and `offset` are counts over the same filters.
     */
    listSessions: f =>
      tables(async (): Promise<SessionPage> => {
        const limit = Math.min(Math.max(Math.floor(f.limit ?? SESSIONS_PAGE), 1), SESSIONS_MAX_LIMIT)
        const { where, args } = filterSql(f)
        const page = async (c: Cursor | undefined, dir: 'after' | 'before'): Promise<SessionRow[]> => {
          const w = c ? [...where, dir === 'after' ? BEHIND : AHEAD] : where
          const order = dir === 'after' ? 'last_ms DESC, sid ASC' : 'last_ms ASC, sid DESC'
          const r = await db
            .prepare(`SELECT ${SESSION_COLUMNS} FROM session_log${whereSql(w)} ORDER BY ${order} LIMIT ${limit}`)
            .bind(...args, ...(c ? keyArgs(c) : []))
            .all<StoredSessionRow>()
          const rows = r.results.map(sessionRow)
          return dir === 'after' ? rows : rows.reverse()
        }
        let rows = f.before ? await page(f.before, 'before') : await page(f.after, 'after')
        if (f.before && rows.length < limit) rows = await page(undefined, 'after')
        const total =
          (await db.prepare(`SELECT COUNT(*) AS n FROM session_log${whereSql(where)}`).bind(...args).first<{ n: number }>())
            ?.n ?? 0
        // Rows ahead of the page's first row; an empty page (an `after` past the end) sits at the end.
        const first = rows[0]
        const offset = first
          ? ((
              await db
                .prepare(`SELECT COUNT(*) AS n FROM session_log${whereSql([...where, AHEAD])}`)
                .bind(...args, ...keyArgs({ lastMs: first.last_ms, sid: first.sid }))
                .first<{ n: number }>()
            )?.n ?? 0)
          : f.after
            ? total
            : 0
        const lastRow = rows[rows.length - 1]
        return {
          sessions: rows,
          total,
          offset,
          prev: first && offset > 0 ? fmtCursor(first) : null,
          next: lastRow && offset + rows.length < total ? fmtCursor(lastRow) : null,
        }
      }),

    /** A session's row and its events, flattened across batches: by `t`, ties by page load, batch and position. */
    sessionDetail: sid =>
      tables(async (): Promise<SessionDetail | null> => {
        const stored = await db.prepare(`SELECT ${SESSION_COLUMNS} FROM session_log WHERE sid = ?`).bind(sid).first<StoredSessionRow>()
        const session = stored ? sessionRow(stored) : null
        if (!session) return null
        const rows = await db
          .prepare('SELECT pid, seq, received_ts, events FROM session_log_batches WHERE sid = ? ORDER BY first_ms, pid, seq')
          .bind(sid)
          .all<{ pid: string; seq: number; received_ts: number; events: string }>()
        const tagged = rows.results.flatMap(r =>
          (JSON.parse(r.events) as SlogEvent[]).map((e, i) => ({ e: { ...e, pid: r.pid, seq: r.seq, _received_ms: r.received_ts * 1000 } as StoredEvent, i })),
        )
        tagged.sort(
          (a, b) => a.e.t - b.e.t || (a.e.pid < b.e.pid ? -1 : a.e.pid > b.e.pid ? 1 : 0) || a.e.seq - b.e.seq || a.i - b.i,
        )
        return { session, events: tagged.map(x => x.e) }
      }),
  }
}
