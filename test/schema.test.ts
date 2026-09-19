/**
 * `migrations/schema.sql` is the whole schema in one apply, for a fresh install.
 * It is *derived* from the numbered migrations (`scripts/gen-schema.mjs`), so it
 * must never drift: applying every migration has to build the same schema as
 * applying `schema.sql`. A migration added without regenerating the file fails
 * here — regenerate with `node scripts/gen-schema.mjs`.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'

const dir = fileURLToPath(new URL('../migrations/', import.meta.url).href)
const MIGRATION_RE = /^\d{4}_.*\.sql$/

interface SchemaObject {
  type: string
  name: string
  sql: string
}

const schemaOf = (apply: (db: DatabaseSync) => void): SchemaObject[] => {
  const db = new DatabaseSync(':memory:')
  apply(db)
  const rows = db
    .prepare(`SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type, name`)
    .all() as unknown as SchemaObject[]
  db.close()
  return rows
}

const fromMigrations = (): SchemaObject[] =>
  schemaOf(db => {
    for (const f of readdirSync(dir).filter(n => MIGRATION_RE.test(n)).sort()) db.exec(readFileSync(dir + f, 'utf8'))
  })

const fromSchemaFile = (): SchemaObject[] => schemaOf(db => db.exec(readFileSync(dir + 'schema.sql', 'utf8')))

describe('migrations/schema.sql', () => {
  it('builds exactly the schema the numbered migrations do (else run `node scripts/gen-schema.mjs`)', () => {
    expect(fromSchemaFile()).toEqual(fromMigrations())
  })
})
