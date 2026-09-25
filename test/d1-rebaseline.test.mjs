/** The pure surface of the squash-rebaseline CLI. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  UsageError,
  diffSchemas,
  executeArgs,
  expectedSchema,
  migrationFiles,
  normalizeSql,
  parseArgs,
  parseExecuteJson,
  rebaselineSql,
  schemaMap,
} from '../scripts/d1-rebaseline.mjs'

/** Run `fn`, return the thrown error (or null) — so a message can be asserted exactly. */
const caught = fn => {
  try {
    fn()
    return null
  } catch (e) {
    return e
  }
}

const dirs = []
/** A scratch migrations dir holding `files` (`name → sql`), under the project's `tmp/`. */
const scratch = files => {
  mkdirSync('tmp', { recursive: true })
  const dir = mkdtempSync(join('tmp', 'rebaseline-test-'))
  dirs.push(dir)
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql)
  return dir
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('normalizeSql', () => {
  it('drops comments, quotes, case and incidental whitespace', () => {
    expect(normalizeSql('CREATE INDEX "a_ts"  ON a ( ts DESC ) -- newest first\n;')).toBe('create index a_ts on a(ts desc)')
  })
})

describe('schemaMap + diffSchemas', () => {
  const at = sql => {
    const dir = scratch({ '0001_x.sql': sql })
    return expectedSchema(dir, migrationFiles(dir))
  }

  it('describes columns, constraints and indexes', () => {
    expect([...at('CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0);\nCREATE INDEX t_n ON t (n);')]).toEqual([
      ['table t', 'exists'],
      ['column t.id', 'TEXT PK#1'],
      ['column t.n', 'INTEGER NOT NULL DEFAULT 0'],
      ['constraint t(id)', 'unique'],
      ['index t_n', 'create index t_n on t(n)'],
    ])
  })

  it('ignores column order and comments: a squash matches the ALTERed table it replaces', () => {
    const live = at('CREATE TABLE t (id TEXT PRIMARY KEY);\nALTER TABLE t ADD COLUMN n TEXT;')
    const squashed = at('-- the table\nCREATE TABLE t (\n  n TEXT, -- a name\n  id TEXT PRIMARY KEY\n);')
    expect(diffSchemas(live, squashed)).toEqual([])
  })

  it('names every difference, sorted', () => {
    const live = at('CREATE TABLE t (id TEXT PRIMARY KEY, first TEXT);\nCREATE INDEX t_first ON t (first);')
    const expected = at('CREATE TABLE t (id TEXT PRIMARY KEY, name TEXT NOT NULL);\nCREATE INDEX t_first ON t (name);')
    expect(diffSchemas(live, expected)).toEqual([
      'differs: index t_first: live create index t_first on t(first) | expected create index t_first on t(name)',
      'missing from live: column t.name (expected TEXT NOT NULL)',
      'only in live: column t.first (TEXT)',
    ])
  })

  it('builds a map from D1-shaped rows the same way', () => {
    const m = schemaMap({
      objects: [{ type: 'index', name: 'i', tbl_name: 't', sql: 'CREATE INDEX i ON t (a)' }],
      columns: [{ tbl: 't', col: 'a', type: 'TEXT', nn: 0, dflt: null, pk: 0 }],
      autoindexes: [],
    })
    expect([...m]).toEqual([
      ['table t', 'exists'],
      ['column t.a', 'TEXT'],
      ['index i', 'create index i on t(a)'],
    ])
  })
})

describe('migrationFiles', () => {
  it("lists every .sql, sorted as wrangler applies them", () => {
    const dir = scratch({ '0002_b.sql': '', '0001_a.sql': '', 'README.md': '' })
    expect(migrationFiles(dir)).toEqual(['0001_a.sql', '0002_b.sql'])
  })
})

describe('rebaselineSql', () => {
  it('replaces the bookkeeping with exactly the given files', () => {
    expect(rebaselineSql(['0001_init.sql', "0002_o'neil.sql"])).toBe(
      "DELETE FROM d1_migrations; INSERT INTO d1_migrations (name) VALUES ('0001_init.sql'), ('0002_o''neil.sql');",
    )
  })

  it('refuses an empty list (that would wipe the bookkeeping)', () => {
    const e = caught(() => rebaselineSql([]))
    expect([e instanceof UsageError, e.message]).toEqual([true, 'no .sql files to record'])
  })
})

describe('parseArgs', () => {
  it('parses the full flag set', () => {
    expect(
      parseArgs([
        '--db', 'oa-auth-demo',
        '--migrations-dir', 'migrations',
        '--local',
        '--persist-to', 'tmp/state',
        '--wrangler', 'demo/scripts/oa-wrangler.sh',
        '--table', 'migs',
        '--run',
      ]),
    ).toEqual({
      db: 'oa-auth-demo',
      migrationsDir: 'migrations',
      target: 'local',
      persistTo: 'tmp/state',
      wrangler: 'demo/scripts/oa-wrangler.sh',
      table: 'migs',
      run: true,
      help: false,
    })
  })

  it('defaults to a dry run through npx wrangler', () => {
    const o = parseArgs(['--db', 'd', '--migrations-dir', 'm', '--remote'])
    expect([o.run, o.wrangler, o.table, o.persistTo]).toEqual([false, 'npx wrangler', 'd1_migrations', null])
  })

  it('rejects missing, conflicting and malformed flags', () => {
    const msg = argv => caught(() => parseArgs(argv)).message
    expect([
      msg(['--migrations-dir', 'm', '--remote']),
      msg(['--db', 'd', '--remote']),
      msg(['--db', 'd', '--migrations-dir', 'm']),
      msg(['--db', 'd', '--migrations-dir', 'm', '--remote', '--local']),
      msg(['--db', 'd', '--migrations-dir', 'm', '--remote', '--persist-to', 'x']),
      msg(['--table', 'a; DROP TABLE x']),
      msg(['--nope']),
    ]).toEqual([
      '--db is required',
      '--migrations-dir is required',
      'pass --remote or --local',
      'pass one of --remote / --local, not both',
      '--persist-to only applies with --local',
      '--table must be an identifier, got "a; DROP TABLE x"',
      'unknown argument "--nope"',
    ])
  })
})

describe('executeArgs + parseExecuteJson', () => {
  it('builds the wrangler argv for one command', () => {
    expect(executeArgs({ db: 'd', target: 'local', persistTo: 's' }, 'SELECT 1')).toEqual([
      'd1', 'execute', 'd', '--local', '--persist-to', 's', '--json', '--yes', '--command', 'SELECT 1',
    ])
  })

  it('reads one result set per statement, past any banner', () => {
    expect(parseExecuteJson('banner\n[{"results":[{"a":1}],"success":true},{"results":[],"success":true}]')).toEqual([[{ a: 1 }], []])
  })
})
