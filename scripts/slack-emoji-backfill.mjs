#!/usr/bin/env node
/**
 * Map people to their custom Slack emoji on the broker's profiles (`profiles.slack_emoji`,
 * specs/done/slack-emoji-claim.md), in two steps with a review between:
 *
 *   SLACK_TOKEN=… node scripts/slack-emoji-backfill.mjs propose [-o tmp/slack-emoji.tsv]
 *   node scripts/slack-emoji-backfill.mjs apply tmp/slack-emoji.tsv [--dry-run]
 *
 * `propose` reads the workspace's custom emoji (`emoji.list`) and members (`users.list`, with emails:
 * `users:read.email`), and the broker's current mappings (`oa-login`, via `broker/scripts/oa-wrangler.sh`). It writes
 * a TSV of proposed changes only: an emoji named after a member's handle, display name or first name, where nobody
 * else's name claims the same emoji. Unmatched members and ambiguous emoji follow as `#` comment lines, for
 * mapping by hand. Edit the file (delete a row to skip it, change its emoji, add a row), then `apply` writes the
 * `set` and `clear` rows to the broker: a row ahead of a person's first sign-in where they have none. Re-running
 * `propose` later proposes only what changed.
 *
 * The token needs `emoji:read`, `users:read` and `users:read.email`. It's read from `$SLACK_TOKEN` and never printed.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const SLACK_EMOJI = /^:[a-z0-9_+'-]{1,100}:$/
const BROKER_DB = 'oa-login'
const WRANGLER = join(dirname(fileURLToPath(import.meta.url)), '..', 'broker', 'scripts', 'oa-wrangler.sh')
export const COLUMNS = ['action', 'email', 'emoji', 'match', 'slack_handle', 'slack_name', 'current']

/** A name as an emoji would spell it: lower-case, spaces and dots joined by `sep` (default nothing), only emoji characters left. */
export const asEmojiName = (name, sep = '') =>
  (name ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').trim().replace(/[\s.]+/g, sep).replace(/[^a-z0-9_+'-]/g, '')

/** The spellings tried for one name: `ben.gottlieb` as `bengottlieb`, `ben-gottlieb` and `ben_gottlieb`. */
const spellings = name => [...new Set(['', '-', '_'].map(sep => asEmojiName(name, sep)))].filter(Boolean)

/** How a member's names are tried, strongest first. */
const MATCHES = [
  ['handle', m => m.name],
  ['display name', m => m.profile?.display_name],
  ['full name', m => m.profile?.real_name],
  ['first name', m => m.profile?.first_name ?? m.profile?.real_name?.split(/\s+/)[0]],
]

/** People with an email: not bots, not deactivated, not Slackbot. */
export const people = members => members.filter(m => !m.deleted && !m.is_bot && m.id !== 'USLACKBOT' && m.profile?.email)

/**
 * The proposal: for each person, the strongest-matching emoji that no other person's names also claim, compared with
 * `current` (`email → ':name:'`). Returns change rows (`set`, or `keep` omitted), plus the unmatched people and the
 * emoji more than one person's names claim.
 */
export function propose({ emoji, members, current = {} }) {
  const names = new Set(Object.keys(emoji))
  const humans = people(members)
  /** emoji → the emails whose names spell it (any strength). */
  const claimants = new Map()
  const candidates = humans.map(m => {
    const found = []
    for (const [kind, pick] of MATCHES) {
      for (const name of spellings(pick(m))) if (names.has(name) && !found.some(f => f.name === name)) found.push({ kind, name })
    }
    for (const f of found) claimants.set(f.name, new Set([...(claimants.get(f.name) ?? []), m.profile.email.toLowerCase()]))
    return { m, found }
  })
  const rows = []
  const unmatched = []
  for (const { m, found } of candidates) {
    const email = m.profile.email.toLowerCase()
    const pick = found.find(f => claimants.get(f.name).size === 1)
    const was = current[email] ?? null
    if (!pick) {
      if (!was) unmatched.push({ email, handle: m.name, name: m.profile.real_name ?? '' })
      continue
    }
    const emoji = `:${pick.name}:`
    if (emoji === was) continue
    rows.push({ action: 'set', email, emoji, match: pick.kind, slack_handle: m.name, slack_name: m.profile.real_name ?? '', current: was ?? '' })
  }
  const ambiguous = [...claimants].filter(([, who]) => who.size > 1).map(([name, who]) => ({ emoji: `:${name}:`, emails: [...who].sort() }))
  const byEmail = (a, b) => a.email.localeCompare(b.email)
  return { rows: rows.sort(byEmail), unmatched: unmatched.sort(byEmail), ambiguous: ambiguous.sort((a, b) => a.emoji.localeCompare(b.emoji)) }
}

/** The reviewable file: a header, the change rows, then the unmatched and ambiguous as `#` lines. */
export function toTsv({ rows, unmatched, ambiguous }) {
  const clean = v => String(v ?? '').replace(/[\t\n]/g, ' ')
  return [
    COLUMNS.join('\t'),
    ...rows.map(r => COLUMNS.map(c => clean(r[c])).join('\t')),
    ...(unmatched.length ? ['#', '# Unmatched (no emoji named after them): add a `set` row above to map one by hand.', ...unmatched.map(u => `# ${u.email}\t${u.handle}\t${clean(u.name)}`)] : []),
    ...(ambiguous.length ? ['#', '# Ambiguous (several people\'s names spell it): not proposed for any of them.', ...ambiguous.map(a => `# ${a.emoji}\t${a.emails.join(', ')}`)] : []),
  ].join('\n') + '\n'
}

/** The approved rows of an edited file: `set` (with an emoji) or `clear`. Throws on a malformed row. */
export function parseTsv(text) {
  const lines = text.split('\n').filter(l => l.trim() && !l.startsWith('#'))
  const [header, ...body] = lines
  if (header !== COLUMNS.join('\t')) throw new Error(`expected the header: ${COLUMNS.join(' ')}`)
  return body.map((line, i) => {
    const [action, email, emoji] = line.split('\t')
    const where = `row ${i + 1}`
    if (!email?.includes('@')) throw new Error(`${where}: no email`)
    if (action === 'clear') return { email: email.trim().toLowerCase(), emoji: null }
    if (action !== 'set') throw new Error(`${where}: action must be set or clear, not ${JSON.stringify(action)}`)
    const bare = (emoji ?? '').trim().toLowerCase().replace(/^:|:$/g, '')
    if (!SLACK_EMOJI.test(`:${bare}:`)) throw new Error(`${where}: not an emoji name: ${JSON.stringify(emoji)}`)
    return { email: email.trim().toLowerCase(), emoji: `:${bare}:` }
  })
}

const sqlString = v => (v === null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`)

/** The upserts `apply` runs: the same as `d1ProfileStore.setSlackEmoji`, a row ahead of sign-in where there's none. */
export const toSql = approved =>
  approved
    .map(({ email, emoji }) =>
      `INSERT INTO profiles (email, name, avatar, avatar_src, updated_at, slack_emoji) VALUES (${sqlString(email)}, NULL, NULL, 'seed-pending', 0, ${sqlString(emoji)}) ON CONFLICT(email) DO UPDATE SET slack_emoji = excluded.slack_emoji;`,
    )
    .join('\n') + '\n'

async function slack(method, params = {}) {
  const token = process.env.SLACK_TOKEN
  if (!token) throw new Error('set SLACK_TOKEN (emoji:read, users:read, users:read.email)')
  const res = await fetch(`https://slack.com/api/${method}?${new URLSearchParams(params)}`, { headers: { authorization: `Bearer ${token}` } })
  const body = await res.json()
  if (!body.ok) throw new Error(`${method}: ${body.error}${body.needed ? ` (needs ${body.needed})` : ''}`)
  return body
}

async function allMembers() {
  const members = []
  let cursor = ''
  do {
    const page = await slack('users.list', { limit: '200', ...(cursor ? { cursor } : {}) })
    members.push(...page.members)
    cursor = page.response_metadata?.next_cursor ?? ''
  } while (cursor)
  return members
}

function wrangler(args) {
  return execFileSync(WRANGLER, args, { encoding: 'utf8', env: { ...process.env, CI: '1' }, stdio: ['ignore', 'pipe', 'inherit'] })
}

function currentMappings() {
  const out = wrangler(['d1', 'execute', BROKER_DB, '--remote', '--json', '--command', 'SELECT email, slack_emoji FROM profiles WHERE slack_emoji IS NOT NULL'])
  const [{ results }] = JSON.parse(out.slice(out.indexOf('[')))
  return Object.fromEntries(results.map(r => [r.email, r.slack_emoji]))
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { output: { type: 'string', short: 'o', default: 'tmp/slack-emoji.tsv' }, 'dry-run': { type: 'boolean', short: 'n' } },
  })
  const [command, file] = positionals
  if (command === 'propose') {
    const [{ emoji }, members] = await Promise.all([slack('emoji.list'), allMembers()])
    const proposal = propose({ emoji, members, current: currentMappings() })
    writeFileSync(values.output, toTsv(proposal))
    console.error(`${proposal.rows.length} changes, ${proposal.unmatched.length} unmatched, ${proposal.ambiguous.length} ambiguous: ${values.output}`)
  } else if (command === 'apply' && file) {
    const approved = parseTsv(readFileSync(file, 'utf8'))
    const sql = toSql(approved)
    if (values['dry-run']) return void process.stdout.write(sql)
    // Absolute: `oa-wrangler.sh` runs from `broker/`.
    const sqlFile = resolve(`${file}.sql`)
    writeFileSync(sqlFile, sql)
    wrangler(['d1', 'execute', BROKER_DB, '--remote', '--file', sqlFile])
    console.error(`applied ${approved.length} rows to ${BROKER_DB}`)
  } else {
    console.error('usage: slack-emoji-backfill.mjs propose [-o FILE] | apply FILE [--dry-run]')
    process.exitCode = 2
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(e => {
    console.error(e.message)
    process.exitCode = 1
  })
}
