#!/usr/bin/env node
/**
 * Move an existing D1 database across a migrations squash.
 *
 * Pre-1.0, a repo's `migrations/` gets collapsed into a baseline (`0001_init.sql`,
 * the current schema). A database already built by the old files is *at* that
 * schema, but wrangler's bookkeeping table (`d1_migrations`) lists the old file
 * names, so `wrangler d1 migrations apply` would try to run the baseline on top
 * of it. This rewrites the bookkeeping — only after proving the live schema is
 * what the new files would build:
 *
 *   1. build the expected schema by applying every `.sql` in `--migrations-dir`
 *      (sorted, as wrangler applies them) to an in-memory SQLite;
 *   2. read the live schema with `wrangler d1 execute --json`;
 *   3. compare structurally — each table's columns (type, NOT NULL, default,
 *      primary-key position), unique constraints, and every index / view /
 *      trigger's SQL (comments and whitespace normalized). Column *order* is
 *      ignored: a squash writes columns where they read best, while a live table
 *      has `ALTER … ADD COLUMN`s appended at the end;
 *   4. if they differ, print the difference and exit 1 without writing;
 *   5. if they match, replace the bookkeeping rows with the new file names.
 *
 * Nothing is app-specific: it works for any schema, including apps that copy the
 * auth tables into their own migration sequence next to their own tables.
 *
 * Default is a dry run (reads only). `--run` writes the bookkeeping.
 *
 * Usage:
 *   scripts/d1-rebaseline.mjs --db oa-auth-demo --migrations-dir migrations \
 *     --remote --wrangler demo/scripts/oa-wrangler.sh [--run]
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

/** A bad flag or value — reported to the user, not a stack trace. */
export class UsageError extends Error {}

const err = (...a) => console.error(...a)

/** Objects that aren't the app's: SQLite internals, D1/workerd internals, and wrangler's bookkeeping. */
const excluded = table => `name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> '${table}'`

/**
 * The three reads that make up a schema, identical on both sides (SQLite and D1).
 * Table-valued pragmas keep each one a single statement.
 */
export function schemaQueries(table = 'd1_migrations') {
  const tables = `SELECT name FROM sqlite_master WHERE type = 'table' AND ${excluded(table)}`
  return {
    objects: `SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL AND type <> 'table' AND ${excluded(table)}`,
    columns:
      `SELECT t.name AS tbl, c.name AS col, c.type AS type, c."notnull" AS nn, c.dflt_value AS dflt, c.pk AS pk ` +
      `FROM (${tables}) t, pragma_table_info(t.name) c`,
    // Constraint-backed indexes (UNIQUE, a non-integer PRIMARY KEY) have no SQL of
    // their own; their columns and uniqueness are the comparable part.
    autoindexes:
      `SELECT t.name AS tbl, l."unique" AS uniq, ` +
      `(SELECT group_concat(name, ',') FROM (SELECT name FROM pragma_index_info(l.name) ORDER BY seqno)) AS cols ` +
      `FROM (${tables}) t, pragma_index_list(t.name) l WHERE l.origin <> 'c'`,
  }
}

/**
 * Comparable SQL: comments stripped, identifier quotes dropped, whitespace
 * collapsed (and removed around punctuation), lower-cased.
 */
export function normalizeSql(sql) {
  return sql
    .replace(/--[^\n]*/g, '')
    .replace(/["`[\]]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),;=])\s*/g, '$1')
    .trim()
    .replace(/;$/, '')
    .toLowerCase()
}

/**
 * A schema as a flat `key → description` map, so two schemas diff as maps. Keys
 * name the thing (`table grants`, `column grants.name`, `index grants_created_at`,
 * `constraint grants(token_hash)`); values are what must match.
 */
export function schemaMap({ objects, columns, autoindexes }) {
  const m = new Map()
  for (const c of columns) {
    m.set(`table ${c.tbl}`, 'exists')
    m.set(
      `column ${c.tbl}.${c.col}`,
      `${c.type || '(untyped)'}${Number(c.nn) ? ' NOT NULL' : ''}` +
        `${c.dflt === null || c.dflt === undefined ? '' : ` DEFAULT ${c.dflt}`}${Number(c.pk) ? ` PK#${c.pk}` : ''}`,
    )
  }
  for (const a of autoindexes) m.set(`constraint ${a.tbl}(${a.cols})`, Number(a.uniq) ? 'unique' : 'non-unique')
  for (const o of objects) m.set(`${o.type} ${o.name}`, normalizeSql(o.sql))
  return m
}

/** Every difference between the live and expected schemas, as one sorted line each. Empty = match. */
export function diffSchemas(live, expected) {
  const out = []
  for (const k of new Set([...live.keys(), ...expected.keys()])) {
    const l = live.get(k)
    const e = expected.get(k)
    if (l === e) continue
    if (l === undefined) out.push(`missing from live: ${k} (expected ${e})`)
    else if (e === undefined) out.push(`only in live: ${k} (${l})`)
    else out.push(`differs: ${k}: live ${l} | expected ${e}`)
  }
  return out.sort()
}

/** Quote a string for a SQL literal. */
const lit = s => `'${String(s).replace(/'/g, "''")}'`

/** The bookkeeping rewrite: exactly `files` recorded as applied, in order. */
export function rebaselineSql(files, table = 'd1_migrations') {
  if (!files.length) throw new UsageError('no .sql files to record')
  return `DELETE FROM ${table}; INSERT INTO ${table} (name) VALUES ${files.map(f => `(${lit(f)})`).join(', ')};`
}

/** The migration files wrangler would apply from `dir`, in its order. */
export function migrationFiles(dir) {
  return readdirSync(dir)
    .filter(f => f.endsWith('.sql'))
    .sort()
}

/** The schema `files` build on an empty database. */
export function expectedSchema(dir, files, table = 'd1_migrations') {
  const db = new DatabaseSync(':memory:')
  try {
    for (const f of files) db.exec(readFileSync(join(dir, f), 'utf8'))
    const q = schemaQueries(table)
    return schemaMap({
      objects: db.prepare(q.objects).all(),
      columns: db.prepare(q.columns).all(),
      autoindexes: db.prepare(q.autoindexes).all(),
    })
  } finally {
    db.close()
  }
}

export function parseArgs(argv) {
  const opts = {
    db: null,
    migrationsDir: null,
    target: null,
    persistTo: null,
    wrangler: 'npx wrangler',
    table: 'd1_migrations',
    run: false,
    help: false,
  }
  let i = 0
  const need = flag => {
    const v = argv[++i]
    if (v === undefined) throw new UsageError(`${flag} needs a value`)
    return v
  }
  const target = t => {
    if (opts.target && opts.target !== t) throw new UsageError('pass one of --remote / --local, not both')
    opts.target = t
  }
  for (; i < argv.length; i++) {
    const a = argv[i]
    switch (a) {
      case '-h':
      case '--help':
        opts.help = true
        break
      case '--run':
        opts.run = true
        break
      case '--remote':
        target('remote')
        break
      case '--local':
        target('local')
        break
      case '--db':
        opts.db = need(a)
        break
      case '--migrations-dir':
        opts.migrationsDir = need(a)
        break
      case '--persist-to':
        opts.persistTo = need(a)
        break
      case '--wrangler':
        opts.wrangler = need(a)
        break
      case '--table':
        opts.table = need(a)
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(opts.table)) throw new UsageError(`--table must be an identifier, got ${JSON.stringify(opts.table)}`)
        break
      default:
        throw new UsageError(`unknown argument ${JSON.stringify(a)}`)
    }
  }
  if (!opts.help) {
    if (!opts.db) throw new UsageError('--db is required')
    if (!opts.migrationsDir) throw new UsageError('--migrations-dir is required')
    if (!opts.target) throw new UsageError('pass --remote or --local')
    if (opts.persistTo && opts.target !== 'local') throw new UsageError('--persist-to only applies with --local')
  }
  return opts
}

/** `wrangler d1 execute` argv for one `--command`. */
export function executeArgs(opts, sql) {
  return [
    'd1',
    'execute',
    opts.db,
    `--${opts.target}`,
    ...(opts.persistTo ? ['--persist-to', opts.persistTo] : []),
    '--json',
    '--yes',
    '--command',
    sql,
  ]
}

/** wrangler's `--json` output: one `{ results }` per statement. Tolerates a banner before it. */
export function parseExecuteJson(stdout) {
  const start = stdout.indexOf('[')
  if (start < 0) throw new Error(`no JSON in wrangler output:\n${stdout}`)
  return JSON.parse(stdout.slice(start)).map(r => r.results ?? [])
}

const HELP = `d1-rebaseline — mark a squashed migrations dir as applied on a D1 database that already has its schema

Required:
  --db <name>               D1 database name (as in wrangler.toml)
  --migrations-dir <path>   the (squashed) migrations directory
  --remote | --local        which copy of the database

Optional:
  --persist-to <dir>        local state dir (with --local)
  --wrangler <cmd>          how to invoke wrangler (default "npx wrangler"; e.g. an account-pinning wrapper)
  --table <name>            wrangler's migrations table (default d1_migrations)
  --run                     write the bookkeeping (default: dry run, reads only)
  -h, --help                this help

Refuses (exit 1) unless the live schema matches what the migrations build.`

async function main(argv) {
  const opts = parseArgs(argv)
  if (opts.help) {
    console.log(HELP)
    return 0
  }
  const [cmd, ...pre] = opts.wrangler.split(/\s+/)
  const execute = sql =>
    parseExecuteJson(execFileSync(cmd, [...pre, ...executeArgs(opts, sql)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }))

  const files = migrationFiles(opts.migrationsDir)
  err(`${opts.migrationsDir}: ${files.join(', ')}`)
  const expected = expectedSchema(opts.migrationsDir, files, opts.table)

  const q = schemaQueries(opts.table)
  const [objects, columns, autoindexes] = execute(`${q.objects}; ${q.columns}; ${q.autoindexes}`)
  const live = schemaMap({ objects, columns, autoindexes })

  const [applied] = execute(`SELECT name FROM ${opts.table} ORDER BY id`)
  err(`${opts.db} (${opts.target}) records as applied: ${applied.map(r => r.name).join(', ') || '(nothing)'}`)

  const diff = diffSchemas(live, expected)
  if (diff.length) {
    err(`schemas differ (${diff.length}) — bring the database to the previous head first; nothing written:`)
    for (const d of diff) err(`  ${d}`)
    return 1
  }
  err(`schemas match (${expected.size} objects/columns)`)

  const sql = rebaselineSql(files, opts.table)
  if (!opts.run) {
    err(`[dry-run] would execute: ${sql}`)
    return 0
  }
  execute(sql)
  const [after] = execute(`SELECT name FROM ${opts.table} ORDER BY id`)
  err(`now records as applied: ${after.map(r => r.name).join(', ')}`)
  return 0
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then(code => process.exit(code))
    .catch(e => {
      err(e instanceof UsageError ? `error: ${e.message}\n\nrun with --help for usage` : e)
      process.exit(2)
    })
}
