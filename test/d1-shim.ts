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

/** Every `.sql` in `migrations/`, in the order wrangler applies them. */
const MIGRATION_RE = /\.sql$/

/** Every `.sql` in one migrations directory, in the order wrangler applies them. */
function applyDir(db: DatabaseSync, dir: string): void {
  for (const name of readdirSync(dir).filter(f => MIGRATION_RE.test(f)).sort()) db.exec(readFileSync(dir + name, 'utf8'))
}

/**
 * A fresh in-memory database with every core migration applied, discovered
 * not listed, plus any optional `tracks` (subdirectories of `migrations/`,
 * e.g. `session-log`). `raw` is the underlying SQLite, for setup and checks.
 */
export function testDbRaw(tracks: string[] = []): { db: D1Database; raw: DatabaseSync } {
  const raw = new DatabaseSync(':memory:')
  applyDir(raw, migrationsDir)
  for (const t of tracks) applyDir(raw, `${migrationsDir}${t}/`)
  return { db: shim(raw), raw }
}

/** A fresh in-memory database with every core migration applied. */
export function testDb(): D1Database {
  return testDbRaw().db
}
