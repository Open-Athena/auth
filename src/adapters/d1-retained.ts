import type {
  CommitIncoming, IncomingResult, PendingIncoming, RetainedBinding, RetainedLimits, RetainedStore,
} from '../core/retained-store.js'
import { serializeSelectionContext } from '../core/selection-context.js'

function integer(value: number, positive = false): void {
  if (!Number.isSafeInteger(value) || Object.is(value, -0) || value < (positive ? 1 : 0)) {
    throw new TypeError('Invalid retained integer')
  }
}

function id(value: string): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) throw new TypeError('Invalid retained ID')
}

function binding(input: RetainedBinding, now: number): void {
  id(input.gateId)
  id(input.browserSetId)
  id(input.handleHash)
  integer(now)
}

function pending(input: PendingIncoming, now: number): void {
  binding(input, now)
  serializeSelectionContext(input.expected)
  if (input.expected.browserSetId !== input.browserSetId) throw new TypeError('Mismatched browser context')
  id(input.pendingId)
  id(input.grantId)
  id(input.tokenHash)
}

/** Internal optional adapter: requires migration 0003 and transactional D1 batch.
 * No read/independent-write completion, compensations or network policy callbacks.
 * Caller must enforce deployment rate admission before bootstrap/pending creation.
 * Hard storage quotas count expired rows too until explicit maintenance removes
 * them. Cleanup and the rest of the registry are intentionally not implemented.
 */
export function d1RetainedStore(db: D1Database, suppliedLimits: RetainedLimits): RetainedStore {
  const limits = { ...suppliedLimits }
  for (const value of Object.values(limits)) integer(value, true)
  // Validate required fields even when an untyped caller omits them.
  for (const key of ['sessions', 'pending', 'gateBrowserSets', 'gatePending', 'browserTtlS',
    'pendingTtlS', 'retryTtlS', 'defaultSessionTtlS'] as const) integer(limits[key], true)
  const sql = (text: string, ...args: (string | number | null)[]) => db.prepare(text).bind(...args)
  const liveBrowser = `b.id = ? AND b.gate_id = ? AND b.handle_hash = ? AND b.expires_at > ?`
  const expectedBrowser = `${liveBrowser} AND b.active_session_id IS ? AND b.selection_version = ?
    AND b.selection_version < 9007199254740991`
  const browserArgs = (i: RetainedBinding, now: number) => [i.browserSetId, i.gateId, i.handleHash, now] as const
  const contextArgs = (i: PendingIncoming, now: number) => [...browserArgs(i, now), i.expected.sessionId, i.expected.version]
  const liveSession = `s.revoked_at IS NULL AND s.expires_at > ? AND g.revoked_at IS NULL
    AND (g.sessions_invalid_before IS NULL OR s.issued_at >= g.sessions_invalid_before)
    AND (g.expiry_ends_sessions = 0 OR g.expires_at IS NULL OR g.expires_at > ?)`

  return {
    async bootstrap(i, now) {
      binding(i, now)
      integer(now + limits.browserTtlS)
      const result = await sql(`INSERT INTO retained_browser_sets (id, gate_id, handle_hash, created_at, expires_at)
        SELECT ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM retained_browser_sets WHERE gate_id = ?) < ?`,
      i.browserSetId, i.gateId, i.handleHash, now, now + limits.browserTtlS, i.gateId, limits.gateBrowserSets).run()
      return result.meta.changes === 1
    },

    async createPending(i, now) {
      pending(i, now)
      integer(now + limits.pendingTtlS)
      const results = await db.batch<PendingIncoming['expected']>([
        sql(`INSERT INTO retained_pending (id, browser_set_id, gate_id, grant_id, token_hash, expires_at, ready)
          SELECT ?, b.id, b.gate_id, g.id, g.token_hash, MIN(?, COALESCE(g.expires_at, ?)), 0
          FROM retained_browser_sets b JOIN grants g ON g.id = ?
          WHERE ${expectedBrowser} AND g.token_hash = ? AND g.revoked_at IS NULL
          AND g.disabled_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > ?)
          AND (SELECT COUNT(*) FROM retained_pending WHERE browser_set_id = b.id
            AND consumed_operation_id IS NULL AND expires_at > ?) < ?
          AND (SELECT COUNT(*) FROM retained_pending WHERE gate_id = b.gate_id) < ?`,
        i.pendingId, now + limits.pendingTtlS, now + limits.pendingTtlS, i.grantId,
        ...contextArgs(i, now), i.tokenHash, now, now, limits.pending, limits.gatePending),
        sql(`UPDATE retained_browser_sets AS b SET selection_version = selection_version + 1
          WHERE ${expectedBrowser} AND EXISTS (SELECT 1 FROM retained_pending WHERE id = ? AND ready = 0)`,
        ...contextArgs(i, now), i.pendingId),
        sql(`UPDATE retained_pending SET ready = CASE WHEN changes() = 1 THEN 1 ELSE -1 END
          WHERE id = ? AND ready = 0`, i.pendingId),
        sql(`SELECT b.id AS browserSetId, b.active_session_id AS sessionId, b.selection_version AS version
          FROM retained_browser_sets b JOIN retained_pending p ON p.browser_set_id = b.id
          WHERE p.id = ? AND p.ready = 1 AND ${liveBrowser}`, i.pendingId, ...browserArgs(i, now)),
      ])
      if (results[0]!.meta.changes !== 1) return null
      return results[3]!.results[0] ?? null
    },

    async commitIncoming(i, now) {
      pending(i, now)
      id(i.operationId)
      id(i.newSessionId)
      if (typeof i.select !== 'boolean') throw new TypeError('Invalid selection mode')
      integer(now + limits.retryTtlS)
      integer(now + limits.defaultSessionTtlS)
      // Explicit key order: extra runtime properties cannot smuggle raw tokens
      // into persistence or change the operation identity. now is NOT retry input.
      const input = JSON.stringify([i.gateId, i.browserSetId, i.handleHash, i.pendingId, i.grantId,
        i.tokenHash, i.expected.sessionId, i.expected.version, i.newSessionId, i.select])
      const attempt = crypto.randomUUID()
      const own = `attempt_id = ?`
      const op = `SELECT * FROM retained_operations WHERE ${own}`
      const assertStage = (stage: number, conditional = false) => sql(`UPDATE retained_operations
        SET stage = CASE WHEN changes() = 1 ${conditional ? 'OR minted = 0' : ''} THEN ? ELSE -1 END
        WHERE ${own}`, stage, attempt)
      const results = await db.batch<IncomingResult>([
        // Claim only after all initial guards pass. Global operation IDs prevent
        // reuse across browser/gate boundaries. A conflict never updates a row.
        sql(`INSERT INTO retained_operations
          (id, browser_set_id, gate_id, input_json, attempt_id, session_id, minted, committed_version, expires_at, stage)
          SELECT ?, b.id, b.gate_id, ?, ?, COALESCE(s.id, ?), s.id IS NULL, b.selection_version + 1, ?, 0
          FROM retained_browser_sets b JOIN retained_pending p ON p.browser_set_id = b.id
          JOIN grants g ON g.id = p.grant_id
          LEFT JOIN retained_sessions s ON s.id = (SELECT s.id FROM retained_sessions s
            WHERE s.browser_set_id = b.id AND s.grant_id = g.id AND ${liveSession} ORDER BY s.id LIMIT 1)
          WHERE ${expectedBrowser} AND p.id = ? AND p.gate_id = b.gate_id AND p.ready = 1
          AND p.grant_id = ? AND p.token_hash = ? AND g.token_hash = p.token_hash
          AND p.expires_at > ? AND p.consumed_operation_id IS NULL
          AND (s.id IS NOT NULL OR (g.revoked_at IS NULL AND g.disabled_at IS NULL
            AND (g.expires_at IS NULL OR g.expires_at > ?)
            AND (g.sessions_invalid_before IS NULL OR g.sessions_invalid_before <= ?)
            AND COALESCE(g.session_ttl, ?) BETWEEN 1 AND 9007199254740991 - ?
            AND (g.max_redeems IS NULL OR g.redeems < g.max_redeems)
            AND (SELECT COUNT(*) FROM retained_sessions WHERE browser_set_id = b.id
              AND revoked_at IS NULL AND expires_at > ?) < ?))
          ON CONFLICT(id) DO NOTHING`,
        i.operationId, input, attempt, i.newSessionId, now + limits.retryTtlS, now, now,
        ...contextArgs(i, now), i.pendingId, i.grantId, i.tokenHash, now, now, now,
        limits.defaultSessionTtlS, now, now, limits.sessions),
        sql(`UPDATE retained_pending SET consumed_operation_id = ? WHERE id = ? AND consumed_operation_id IS NULL
          AND EXISTS (${op})`, i.operationId, i.pendingId, attempt),
        assertStage(1),
        sql(`UPDATE grants SET redeems = redeems + 1, first_used_at = COALESCE(first_used_at, ?), last_used_at = ?
          WHERE id = ? AND token_hash = ? AND revoked_at IS NULL AND disabled_at IS NULL
          AND (expires_at IS NULL OR expires_at > ?) AND (max_redeems IS NULL OR redeems < max_redeems)
          AND EXISTS (${op} AND minted = 1)`, now, now, i.grantId, i.tokenHash, now, attempt),
        assertStage(2, true),
        sql(`INSERT INTO retained_sessions (id, browser_set_id, grant_id, issued_at, expires_at)
          SELECT o.session_id, o.browser_set_id, g.id, ?, ? + COALESCE(g.session_ttl, ?)
          FROM retained_operations o JOIN grants g ON g.id = ? WHERE o.attempt_id = ? AND o.minted = 1`,
        now, now, limits.defaultSessionTtlS, i.grantId, attempt),
        assertStage(3, true),
        sql(`UPDATE retained_browser_sets AS b SET
          active_session_id = CASE WHEN ? = 1 THEN (SELECT session_id FROM retained_operations WHERE ${own})
            ELSE active_session_id END, selection_version = selection_version + 1
          WHERE ${expectedBrowser} AND EXISTS (${op})`,
        i.select ? 1 : 0, attempt, ...contextArgs(i, now), attempt),
        assertStage(4),
        sql(`UPDATE retained_operations SET stage = 5 WHERE ${own} AND stage = 4
          AND EXISTS (SELECT 1 FROM retained_pending WHERE id = ? AND consumed_operation_id = retained_operations.id)
          AND EXISTS (SELECT 1 FROM retained_sessions WHERE id = retained_operations.session_id
            AND browser_set_id = retained_operations.browser_set_id)
          AND EXISTS (SELECT 1 FROM retained_browser_sets WHERE id = retained_operations.browser_set_id
            AND selection_version = retained_operations.committed_version)`, attempt, i.pendingId),
        assertStage(5),
        // This SELECT is inside the write transaction, not a potentially stale
        // post-commit read. Replays deliberately do not compare current version.
        sql(`SELECT o.session_id AS sessionId, o.committed_version AS committedVersion
          FROM retained_operations o JOIN retained_browser_sets b ON b.id = o.browser_set_id
          WHERE o.id = ? AND o.input_json = ? AND o.gate_id = ? AND o.stage = 5
          AND o.expires_at > ? AND ${liveBrowser}`,
        i.operationId, input, i.gateId, now, ...browserArgs(i, now)),
      ])
      return results[11]!.results[0] ?? null
    },
  }
}
