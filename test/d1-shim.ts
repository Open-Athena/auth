/**
 * A `D1Database`-shaped facade over Node's built-in SQLite, so the D1 adapter's
 * real SQL — the atomic redeem CAS and the partial unique index that dedupes
 * `view` rows — is exercised by the test suite rather than reimplemented in a
 * mock. Only the handful of D1 methods the adapter uses are implemented.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

type Row = Record<string, unknown>

function shim(db: DatabaseSync): D1Database {
  const prepare = (sql: string, args: unknown[] = []): D1PreparedStatement => {
    const stmt = () => db.prepare(sql)
    const bound = args as never[]
    return {
      bind: (...next: unknown[]) => prepare(sql, next),
      first: async () => (stmt().get(...bound) ?? null) as never,
      all: async () => ({ results: stmt().all(...bound) as Row[] }) as never,
      run: async () => {
        const res = stmt().run(...bound)
        return { meta: { changes: Number(res.changes) } } as never
      },
      raw: async () => [] as never,
    } as unknown as D1PreparedStatement
  }
  return { prepare: (sql: string) => prepare(sql) } as unknown as D1Database
}

const migrationsDir = fileURLToPath(new URL('../migrations/', import.meta.url).href)

/** A fresh in-memory database with every migration applied, discovered not listed. */
export function testDb(): D1Database {
  const db = new DatabaseSync(':memory:')
  for (const name of readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort()) {
    db.exec(readFileSync(migrationsDir + name, 'utf8'))
  }
  return shim(db)
}
