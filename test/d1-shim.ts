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
  // `batch` runs its statements in one transaction, like D1's — the allowlist
  // sync's replace-by-source relies on the delete and re-insert being atomic.
  const batch = async (stmts: D1PreparedStatement[]) => {
    db.exec('BEGIN')
    try {
      const out: unknown[] = []
      for (const s of stmts) out.push(await s.run())
      db.exec('COMMIT')
      return out
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  }
  return { prepare: (sql: string) => prepare(sql), batch } as unknown as D1Database
}

const migrationsDir = fileURLToPath(new URL('../migrations/', import.meta.url).href)

/** Only `NNNN_*.sql` are migrations; `schema.sql` is the derived one-file dump. */
const MIGRATION_RE = /^\d{4}_.*\.sql$/

/** A fresh in-memory database with every migration applied, discovered not listed. */
export function testDb(): D1Database {
  const db = new DatabaseSync(':memory:')
  for (const name of readdirSync(migrationsDir).filter(f => MIGRATION_RE.test(f)).sort()) {
    db.exec(readFileSync(migrationsDir + name, 'utf8'))
  }
  return shim(db)
}
