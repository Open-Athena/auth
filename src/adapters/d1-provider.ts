/**
 * The OIDC provider's D1 store: `provider_codes`, from `migrations/provider/`
 * (a track of its own, applied only on the deployment that issues identity).
 */
import type { CodeRecord, ProviderStore } from '../provider/store.js'

interface CodeRow {
  code_hash: string
  client_id: string
  redirect_uri: string
  challenge: string
  nonce: string | null
  email: string
  scope: string
  auth_time: number | null
  expires_at: number
}

const fromRow = (r: CodeRow): CodeRecord => ({
  codeHash: r.code_hash,
  clientId: r.client_id,
  redirectUri: r.redirect_uri,
  challenge: r.challenge,
  nonce: r.nonce,
  email: r.email,
  scope: r.scope,
  authTime: r.auth_time,
  expiresAt: r.expires_at,
})

export interface D1ProviderOptions {
  /** Expired codes one `cleanup` deletes at most (default 500). */
  cleanupChunk?: number
}

export function d1ProviderStore(db: D1Database, { cleanupChunk = 500 }: D1ProviderOptions = {}): ProviderStore {
  return {
    async putCode(c) {
      await db
        .prepare(
          `INSERT INTO provider_codes (code_hash, client_id, redirect_uri, challenge, nonce, email, scope, auth_time, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(c.codeHash, c.clientId, c.redirectUri, c.challenge, c.nonce, c.email, c.scope, c.authTime, c.expiresAt)
        .run()
    },
    async takeCode(codeHash, nowS) {
      // One statement: delete-and-return is the single-use guarantee.
      const row = await db.prepare('DELETE FROM provider_codes WHERE code_hash = ? RETURNING *').bind(codeHash).first<CodeRow>()
      return row && row.expires_at > nowS ? fromRow(row) : null
    },
    async cleanup(nowS) {
      const r = await db
        .prepare('DELETE FROM provider_codes WHERE rowid IN (SELECT rowid FROM provider_codes WHERE expires_at <= ? LIMIT ?)')
        .bind(nowS, cleanupChunk)
        .run()
      return r.meta.changes ?? 0
    },
  }
}
