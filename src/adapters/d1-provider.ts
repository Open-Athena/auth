/**
 * The OIDC provider's D1 stores: `provider_codes` and the client registry, from
 * `migrations/provider/` (a track of its own, applied only on the deployment
 * that issues identity).
 */
import type { ClientAction, ClientEvent, ClientRegistry, RegisteredClient } from '../provider/registry.js'
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
    async noteSpent(codeHash, expiresAt) {
      await db.prepare('INSERT OR REPLACE INTO provider_spent_codes (code_hash, revoked, expires_at) VALUES (?, 0, ?)').bind(codeHash, expiresAt).run()
    },
    async revokeSpent(codeHash) {
      await db.prepare('UPDATE provider_spent_codes SET revoked = 1 WHERE code_hash = ?').bind(codeHash).run()
    },
    async isSpentRevoked(codeHash) {
      const row = await db.prepare('SELECT revoked FROM provider_spent_codes WHERE code_hash = ?').bind(codeHash).first<{ revoked: number }>()
      return row?.revoked === 1
    },
    async cleanup(nowS) {
      let gone = 0
      for (const table of ['provider_codes', 'provider_spent_codes']) {
        const r = await db
          .prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE expires_at <= ? LIMIT ?)`)
          .bind(nowS, cleanupChunk)
          .run()
        gone += r.meta.changes ?? 0
      }
      return gone
    },
  }
}

interface ClientRow {
  id: string
  name: string
  secret_hash: string
  redirect_uris: string
  post_logout_redirect_uris: string
  disabled_at: number | null
  created_at: number
  created_by: string
  updated_at: number
  updated_by: string
}

const clientFromRow = (r: ClientRow): RegisteredClient => ({
  id: r.id,
  name: r.name,
  secretHash: r.secret_hash,
  redirectUris: JSON.parse(r.redirect_uris) as string[],
  postLogoutRedirectUris: JSON.parse(r.post_logout_redirect_uris) as string[],
  disabledAt: r.disabled_at,
  createdAt: r.created_at,
  createdBy: r.created_by,
  updatedAt: r.updated_at,
  updatedBy: r.updated_by,
})

export function d1ClientRegistry(db: D1Database): ClientRegistry {
  const now = () => Math.floor(Date.now() / 1000)
  const logged = (id: string, action: ClientAction, actor: string, at: number, detail: string | null) =>
    db.prepare('INSERT INTO provider_client_events (client_id, action, actor, at, detail) VALUES (?, ?, ?, ?, ?)').bind(id, action, actor, at, detail)
  /** One change and its log row, in one transaction. */
  const change = async (id: string, sql: string, binds: unknown[], action: ClientAction, actor: string, at: number, detail: string | null = null) => {
    const exists = await db.prepare('SELECT 1 FROM provider_clients WHERE id = ?').bind(id).first()
    if (!exists) return false
    await db.batch([db.prepare(sql).bind(...binds), logged(id, action, actor, at, detail)])
    return true
  }
  return {
    async get(id) {
      const row = await db.prepare('SELECT * FROM provider_clients WHERE id = ?').bind(id).first<ClientRow>()
      return row ? clientFromRow(row) : null
    },
    async list() {
      const { results } = await db.prepare('SELECT * FROM provider_clients ORDER BY id').all<ClientRow>()
      return results.map(clientFromRow)
    },
    async create(c, actor) {
      const at = now()
      const [inserted] = await db.batch([
        db
          .prepare(
            `INSERT INTO provider_clients (id, name, secret_hash, redirect_uris, post_logout_redirect_uris, created_at, created_by, updated_at, updated_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
          )
          .bind(c.id, c.name, c.secretHash, JSON.stringify(c.redirectUris), JSON.stringify(c.postLogoutRedirectUris ?? []), at, actor, at, actor),
        db
          .prepare(
            `INSERT INTO provider_client_events (client_id, action, actor, at, detail)
             SELECT ?, 'create', ?, ?, ?
             WHERE NOT EXISTS (SELECT 1 FROM provider_client_events WHERE client_id = ? AND action = 'create')`,
          )
          .bind(c.id, actor, at, JSON.stringify(c.redirectUris), c.id),
      ])
      return (inserted?.meta.changes ?? 0) > 0
    },
    update(id, c, actor) {
      const at = now()
      return change(
        id,
        'UPDATE provider_clients SET name = ?, redirect_uris = ?, post_logout_redirect_uris = ?, updated_at = ?, updated_by = ? WHERE id = ?',
        [c.name, JSON.stringify(c.redirectUris), JSON.stringify(c.postLogoutRedirectUris), at, actor, id],
        'update',
        actor,
        at,
        JSON.stringify(c.redirectUris),
      )
    },
    rotate(id, secretHash, actor) {
      const at = now()
      return change(id, 'UPDATE provider_clients SET secret_hash = ?, updated_at = ?, updated_by = ? WHERE id = ?', [secretHash, at, actor, id], 'rotate', actor, at)
    },
    setDisabled(id, disabled, actor) {
      const at = now()
      return change(
        id,
        'UPDATE provider_clients SET disabled_at = ?, updated_at = ?, updated_by = ? WHERE id = ?',
        [disabled ? at : null, at, actor, id],
        disabled ? 'disable' : 'enable',
        actor,
        at,
      )
    },
    async events(limit = 50) {
      const { results } = await db
        .prepare('SELECT client_id, action, actor, at, detail FROM provider_client_events ORDER BY id DESC LIMIT ?')
        .bind(limit)
        .all<{ client_id: string; action: ClientAction; actor: string; at: number; detail: string | null }>()
      return results.map((r): ClientEvent => ({ clientId: r.client_id, action: r.action, actor: r.actor, at: r.at, detail: r.detail }))
    },
  }
}
