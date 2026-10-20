/**
 * The schema `migrations/` builds on a fresh database: every table and its
 * columns, and every index. A column or index added, dropped or renamed without
 * updating this list fails here.
 */
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { expectedSchema, migrationFiles } from '../scripts/d1-rebaseline.mjs'

const dir = fileURLToPath(new URL('../migrations/', import.meta.url).href)
const schema = expectedSchema(dir, migrationFiles(dir))

/** `table → [column descriptions]`, columns in the order the schema declares them. */
const tables = () => {
  const out = {}
  for (const [k, v] of schema) {
    const m = /^column (\w+)\.(\w+)$/.exec(k)
    if (m) (out[m[1]] ??= []).push(`${m[2]} ${v}`)
  }
  return out
}

describe('migrations/', () => {
  // Pre-1.0: one baseline, plus any additions not yet squashed into it.
  it('is the baseline plus unsquashed additions', () => {
    expect(migrationFiles(dir)).toEqual(['0001_init.sql', '0002_access_log_location.sql', '0003_retained_logins.sql'])
  })

  it('builds exactly these tables and columns', () => {
    expect(tables()).toEqual({
      grants: [
        'id TEXT PK#1',
        'token_hash TEXT NOT NULL',
        'name TEXT',
        'note TEXT',
        'subject_json TEXT',
        'email TEXT',
        'scopes TEXT NOT NULL',
        'max_redeems INTEGER',
        'redeems INTEGER NOT NULL DEFAULT 0',
        'expires_at INTEGER',
        'expiry_ends_sessions INTEGER NOT NULL DEFAULT 1',
        'session_ttl INTEGER',
        'created_at INTEGER NOT NULL',
        'created_by TEXT NOT NULL',
        'disabled_at INTEGER',
        'revoked_at INTEGER',
        'sessions_invalid_before INTEGER',
        'first_used_at INTEGER',
        'last_used_at INTEGER',
      ],
      access_log: [
        'id INTEGER PK#1',
        'ts INTEGER NOT NULL',
        'event TEXT NOT NULL',
        'grant_id TEXT',
        'session_sub TEXT',
        'path TEXT',
        'status INTEGER',
        'ip_hash TEXT',
        'ua TEXT',
        'country TEXT',
        'referer TEXT',
        'reason TEXT',
        'bucket INTEGER',
        'city TEXT',
        'region TEXT',
        'as_org TEXT',
      ],
      access_log_daily: [
        'day INTEGER NOT NULL PK#1',
        'event TEXT NOT NULL PK#2',
        'grant_id TEXT PK#3',
        'path TEXT PK#4',
        'country TEXT PK#5',
        'events INTEGER NOT NULL',
        'clients INTEGER NOT NULL',
      ],
      access_requests: [
        'id TEXT PK#1',
        'email TEXT NOT NULL',
        'name TEXT',
        'note TEXT',
        'subject_json TEXT',
        'created_at INTEGER NOT NULL',
        'status TEXT NOT NULL',
        'decided_at INTEGER',
        'decided_by TEXT',
        'grant_id TEXT',
        'ip_hash TEXT',
      ],
      profiles: ['email TEXT PK#1', 'name TEXT', 'avatar TEXT', 'avatar_src TEXT', 'updated_at INTEGER NOT NULL'],
      pending_auth: [
        'id TEXT PK#1',
        'email TEXT NOT NULL',
        'token_hash TEXT NOT NULL',
        'code_hash TEXT NOT NULL',
        'ip_hash TEXT',
        'created_at INTEGER NOT NULL',
        'expires_at INTEGER NOT NULL',
        'consumed_at INTEGER',
        'attempts INTEGER NOT NULL DEFAULT 0',
      ],
      allowed_emails: [
        'email TEXT PK#1',
        'scopes TEXT NOT NULL',
        "source TEXT NOT NULL DEFAULT 'manual'",
        'note TEXT',
        'added_by TEXT',
        'updated_at INTEGER NOT NULL',
      ],
      retained_browser_sets: [
        'id TEXT NOT NULL PK#1',
        'gate_id TEXT NOT NULL',
        'handle_hash TEXT NOT NULL',
        'active_session_id TEXT',
        'selection_version INTEGER NOT NULL DEFAULT 0',
        'created_at INTEGER NOT NULL',
        'expires_at INTEGER NOT NULL',
      ],
      retained_sessions: [
        'id TEXT NOT NULL PK#1',
        'browser_set_id TEXT NOT NULL',
        'grant_id TEXT NOT NULL',
        'issued_at INTEGER NOT NULL',
        'expires_at INTEGER NOT NULL',
        'revoked_at INTEGER',
      ],
      retained_pending: [
        'id TEXT NOT NULL PK#1',
        'browser_set_id TEXT NOT NULL',
        'gate_id TEXT NOT NULL',
        'grant_id TEXT NOT NULL',
        'token_hash TEXT NOT NULL',
        'expires_at INTEGER NOT NULL',
        'consumed_operation_id TEXT',
        'ready INTEGER NOT NULL',
      ],
      retained_operations: [
        'id TEXT NOT NULL PK#1',
        'browser_set_id TEXT NOT NULL',
        'gate_id TEXT NOT NULL',
        'input_json TEXT NOT NULL',
        'attempt_id TEXT NOT NULL',
        'session_id TEXT NOT NULL',
        'minted INTEGER NOT NULL',
        'committed_version INTEGER NOT NULL',
        'expires_at INTEGER NOT NULL',
        'stage INTEGER NOT NULL',
      ],
    })
  })

  it('builds exactly these indexes and unique constraints', () => {
    expect([...schema.keys()].filter(k => !/^(table|column) /.test(k)).sort()).toEqual([
      'constraint access_log_daily(day,event,grant_id,path,country)',
      'constraint access_requests(id)',
      'constraint allowed_emails(email)',
      'constraint grants(id)',
      'constraint grants(token_hash)',
      'constraint pending_auth(id)',
      'constraint profiles(email)',
      'constraint retained_browser_sets(gate_id,handle_hash)',
      'constraint retained_browser_sets(id)',
      'constraint retained_operations(attempt_id)',
      'constraint retained_operations(id)',
      'constraint retained_pending(id)',
      'constraint retained_sessions(id)',
      'index access_log_daily_day',
      'index access_log_daily_grant',
      'index access_log_dedupe',
      'index access_log_grant',
      'index access_log_ts',
      'index access_requests_created_at',
      'index access_requests_email',
      'index access_requests_one_pending',
      'index access_requests_status',
      'index allowed_emails_source',
      'index grants_created_at',
      'index grants_disabled_at',
      'index pending_auth_email',
      'index pending_auth_ip',
      'index pending_auth_token',
      'index retained_browser_gate',
      'index retained_operation_expiry',
      'index retained_pending_browser',
      'index retained_pending_gate',
      'index retained_session_membership',
    ])
  })
})
