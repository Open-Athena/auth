/**
 * Migration 0013 folds the old first/last pair into one `name`: the `profiles`
 * columns, and the `first`/`last` keys inside `grants.subject_json` and
 * `access_requests.subject_json`. Applied to a DB at 0012 holding rows of every
 * shape the pair could have left behind.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'

const dir = fileURLToPath(new URL('../migrations/', import.meta.url).href)
const migrations = readdirSync(dir).filter(n => /^\d{4}_.*\.sql$/.test(n)).sort()
const apply = (db: DatabaseSync, files: string[]) => {
  for (const f of files) db.exec(readFileSync(dir + f, 'utf8'))
}

const SUBJECTS: [string, string | null][] = [
  ['pair', '{"first":"Ada","last":"Lovelace","avatar":"https://cdn.test/a.png"}'],
  ['first-only', '{"first":"Cher"}'],
  ['last-only', '{"last":"Smith","email":"s@x.test"}'],
  ['blank-pair', '{"first":"","last":""}'],
  ['already-name', '{"name":"Grace Hopper"}'],
  ['no-subject', null],
]

function at0012(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  apply(db, migrations.filter(f => f < '0013'))
  const profile = db.prepare(`INSERT INTO profiles (email, first, last, avatar, avatar_src, updated_at) VALUES (?, ?, ?, NULL, NULL, 1)`)
  profile.run('pair@x.test', 'Ada', 'Lovelace')
  profile.run('first@x.test', 'Cher', null)
  profile.run('last@x.test', null, 'Smith')
  profile.run('none@x.test', null, null)
  const grant = db.prepare(
    `INSERT INTO grants (id, token_hash, subject_json, scopes, created_at, created_by) VALUES (?, ?, ?, 'reports', 1, 'admin')`,
  )
  const request = db.prepare(`INSERT INTO access_requests (id, email, subject_json, created_at, status) VALUES (?, ?, ?, 1, 'pending')`)
  for (const [id, json] of SUBJECTS) {
    grant.run(id, `hash-${id}`, json)
    request.run(id, `${id}@x.test`, json)
  }
  return db
}

const EXPECTED_SUBJECTS = [
  ['already-name', '{"name":"Grace Hopper"}'],
  ['blank-pair', null],
  ['first-only', '{"name":"Cher"}'],
  ['last-only', '{"email":"s@x.test","name":"Smith"}'],
  ['no-subject', null],
  ['pair', '{"avatar":"https://cdn.test/a.png","name":"Ada Lovelace"}'],
]

// JSON key order is SQLite's, not ours; compare the parsed values, sorted by key.
const canon = (json: unknown): string | null =>
  json === null ? null : JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(json as string)).sort()))

describe('migration 0013 (single name)', () => {
  it('backfills profiles.name from the pair and drops the pair columns', () => {
    const db = at0012()
    apply(db, ['0013_single_name.sql'])
    expect(db.prepare(`SELECT * FROM profiles ORDER BY email`).all().map(r => ({ ...r }))).toEqual([
      { email: 'first@x.test', avatar: null, avatar_src: null, updated_at: 1, name: 'Cher' },
      { email: 'last@x.test', avatar: null, avatar_src: null, updated_at: 1, name: 'Smith' },
      { email: 'none@x.test', avatar: null, avatar_src: null, updated_at: 1, name: null },
      { email: 'pair@x.test', avatar: null, avatar_src: null, updated_at: 1, name: 'Ada Lovelace' },
    ])
  })

  it.each(['grants', 'access_requests'])('rewrites %s.subject_json first/last into name, leaving other rows alone', table => {
    const db = at0012()
    apply(db, ['0013_single_name.sql'])
    const rows = db.prepare(`SELECT id, subject_json FROM ${table} ORDER BY id`).all() as { id: string; subject_json: string | null }[]
    expect(rows.map(r => [r.id, canon(r.subject_json)])).toEqual(EXPECTED_SUBJECTS.map(([id, json]) => [id, canon(json)]))
  })
})
