import { checkAcceptance, checkBinding, checkCleanup, type BackchannelStore } from '../backchannel/store.js'

/** Each accept uses one transaction; guard failures must never mutate the target SID. */
export function d1BackchannelStore(db: D1Database): BackchannelStore {
  return {
    async accept(e, nowS, retainUntil) {
      checkAcceptance(e, nowS, retainUntil)
      const [inserted, , receipt] = await db.batch([
        db.prepare(`INSERT INTO backchannel_receipts
          (issuer, client_id, jti, digest, sid, sub, accepted_at, expires_at, retain_until)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (
            SELECT 1 FROM backchannel_revoked_sids WHERE issuer = ? AND client_id = ? AND sid = ?
            AND sub IS NOT NULL AND ? IS NOT NULL AND sub != ?
          ) ON CONFLICT (issuer, client_id, jti) DO NOTHING`)
          .bind(e.issuer, e.clientId, e.jti, e.digest, e.sid, e.sub, nowS, e.expiresAt, retainUntil,
            e.issuer, e.clientId, e.sid, e.sub, e.sub),
        // Derive retention from the original receipt: a replay cannot extend a tombstone.
        db.prepare(`INSERT INTO backchannel_revoked_sids (issuer, client_id, sid, sub, revoked_at, retain_until)
          SELECT issuer, client_id, sid, sub, accepted_at, retain_until FROM backchannel_receipts
          WHERE issuer = ? AND client_id = ? AND jti = ? AND digest = ? AND expires_at > ?
          ON CONFLICT (issuer, client_id, sid) DO UPDATE SET
            sub = COALESCE(backchannel_revoked_sids.sub, excluded.sub),
            retain_until = MAX(backchannel_revoked_sids.retain_until, excluded.retain_until)
          WHERE backchannel_revoked_sids.sub IS NULL OR excluded.sub IS NULL OR backchannel_revoked_sids.sub = excluded.sub`)
          .bind(e.issuer, e.clientId, e.jti, e.digest, nowS),
        db.prepare('SELECT digest FROM backchannel_receipts WHERE issuer = ? AND client_id = ? AND jti = ?')
          .bind(e.issuer, e.clientId, e.jti),
      ])
      const row = receipt?.results[0] as { digest: string } | undefined
      if (!row || row.digest !== e.digest) return 'conflict'
      return inserted?.meta.changes === 1 ? 'accepted' : 'duplicate'
    },
    async isRevoked(b, nowS) {
      checkBinding(b, nowS)
      const row = await db.prepare(`SELECT 1 AS revoked FROM backchannel_revoked_sids
        WHERE issuer = ? AND client_id = ? AND sid = ? AND retain_until > ?`)
        .bind(b.issuer, b.clientId, b.sid, nowS).first()
      return row !== null
    },
    async cleanup(nowS, limit = 500) {
      checkCleanup(nowS, limit)
      const [receipts, sids] = await db.batch([
        db.prepare(`DELETE FROM backchannel_receipts WHERE rowid IN
          (SELECT rowid FROM backchannel_receipts WHERE expires_at <= ? LIMIT ?)`)
          .bind(nowS, limit),
        db.prepare(`DELETE FROM backchannel_revoked_sids WHERE rowid IN
          (SELECT rowid FROM backchannel_revoked_sids WHERE retain_until <= ? LIMIT ?)`)
          .bind(nowS, limit),
      ])
      return (receipts?.meta.changes ?? 0) + (sids?.meta.changes ?? 0)
    },
  }
}
