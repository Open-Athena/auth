#!/usr/bin/env node
/**
 * Install the published `dist` branch the way a consumer would, and check the
 * artifact actually works.
 *
 * The repo's own tests run against `src/`, which says nothing about whether the
 * *published* thing resolves: an exports map pointing at a file the build didn't
 * emit, a missing `type: module`, dropped peer deps, or migrations left behind
 * would all pass CI and fail every consumer. Since consumers pin dist SHAs, that
 * gap is worth closing in CI rather than discovering downstream.
 *
 * Usage: node scripts/verify-dist.mjs [<repo>] [<ref>]
 *   defaults: Open-Athena/auth, the current `dist` branch head
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = process.argv[2] ?? 'Open-Athena/auth'
const REF = process.argv[3] ?? 'dist'

/** Capture stdout. */
const capture = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...opts }).trim()

/** Stream straight through; `execFileSync` returns null under `inherit`. */
const run = (cmd, args, opts = {}) => void execFileSync(cmd, args, { stdio: 'inherit', ...opts })

// Resolve the ref to a SHA, so the check pins exactly what a consumer would.
const sha = capture('git', ['ls-remote', `https://github.com/${REPO}.git`, REF])
  .split('\n')[0]
  ?.split(/\s+/)[0]
if (!sha) throw new Error(`could not resolve ${REPO}#${REF}`)

const dir = mkdtempSync(join(tmpdir(), 'oa-auth-verify-'))
console.log(`verifying ${REPO}#${REF} @ ${sha.slice(0, 7)} in ${dir}`)

writeFileSync(
  join(dir, 'package.json'),
  JSON.stringify({ name: 'verify', private: true, type: 'module', dependencies: { '@open-athena/auth': `github:${REPO}#${sha}` } }, null, 2),
)

const CHECK = String.raw`
import { authRoutes, createGate, domainPolicy, hasScope, hashToken, isBot } from '@open-athena/auth'
import { d1AuditQuery, d1AuditSink, d1GrantStore, d1RequestStore, rollupAccessLog } from '@open-athena/auth/d1'
import { ssoHandler, verifyAccessJwt } from '@open-athena/auth/cf-access'
import { memoryAudit, memoryGrantStore, memoryRequestStore } from '@open-athena/auth/testing'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const req = createRequire(import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('./node_modules/@open-athena/auth/package.json', import.meta.url), 'utf8'))
const migrations = ['0001_grants', '0002_access_log', '0003_access_requests', '0004_access_log_daily', '0005_dedupe_by_event']
  .map(m => readFileSync(req.resolve('@open-athena/auth/migrations/' + m + '.sql'), 'utf8'))

const rows = new Map(), hashes = new Map()
const store = {
  byId: async id => rows.get(id) ?? null,
  byTokenHash: async h => rows.get(hashes.get(h)) ?? null,
  insert: async (g, h) => { rows.set(g.id, { ...g }); hashes.set(h, g.id) },
  redeem: async (id, now) => {
    const g = rows.get(id); if (!g || g.revokedAt) return null
    const n = { ...g, redeems: g.redeems + 1, lastUsedAt: now }; rows.set(id, n); return n
  },
  touch: async () => {},
  revoke: async id => { const g = rows.get(id); if (!g || g.revokedAt) return false; rows.set(id, { ...g, revokedAt: 1 }); return true },
  list: async () => [...rows.values()],
}

const UA = 'Mozilla/5.0 Chrome/140'
const withCookie = c => new Request('https://x.test/d', { headers: { Cookie: c, 'User-Agent': UA } })
const gate = createGate({ store, secret: 'x'.repeat(32), policy: domainPolicy(['openathena.ai'], ['internal']) })
const { grant, token } = await gate.mint({ name: 'Bob', scopes: ['reports'], createdBy: 'me@openathena.ai' })
const redeemed = await gate.redeem(token, new Request('https://x.test/r', { headers: { 'User-Agent': UA } }))
const cookie = redeemed.cookie.split(';')[0]
const authed = await gate.authenticate(withCookie(cookie))
await gate.revoke(grant.id)
const afterRevoke = await gate.authenticate(withCookie(cookie))

const checks = {
  'version is a dist build':      /-dist\./.test(manifest.version),
  'type: module':                 manifest.type === 'module',
  'no dev-only fields':           !manifest.scripts && !manifest.devDependencies && !manifest.pnpm,
  'peer deps declared':           ['react', '@tanstack/react-query'].every(d => d in (manifest.peerDependencies ?? {})),
  'peer deps optional':           ['react', '@tanstack/react-query'].every(d => manifest.peerDependenciesMeta?.[d]?.optional),
  'all entrypoints callable':     [createGate, authRoutes, d1GrantStore, d1RequestStore, d1AuditSink, d1AuditQuery, rollupAccessLog, verifyAccessJwt, ssoHandler].every(f => typeof f === 'function'),
  'migrations shipped':           migrations.length === 5 && migrations[0].includes('CREATE TABLE grants'),
  'token shape':                  /^[A-Za-z0-9_-]{32}$/.test(token),
  'token hashed to 43 chars':     (await hashToken(token)).length === 43,
  'redeem mints a session':       redeemed.ok === true,
  'session resolves to grant':    authed?.grant?.name === 'Bob',
  'scopes enforced':              hasScope(authed, 'reports') && !hasScope(authed, 'admin'),
  'revoke kills live session':    afterRevoke === null,
  'bot filter discriminates':     isBot('Googlebot/2.1') === true && isBot(UA) === false,
  'testing stores exported':      [memoryGrantStore, memoryRequestStore, memoryAudit].every(f => typeof f === 'function'),
}

let failed = 0
for (const [name, ok] of Object.entries(checks)) {
  console.log((ok ? '  ok   ' : '  FAIL ') + name)
  if (!ok) failed++
}
console.log('\n' + manifest.version + ': ' + (Object.keys(checks).length - failed) + '/' + Object.keys(checks).length + ' checks passed')
process.exit(failed ? 1 : 0)
`
writeFileSync(join(dir, 'check.mjs'), CHECK)

try {
  run('pnpm', ['install', '--ignore-workspace', '--no-frozen-lockfile'], { cwd: dir })
  execFileSync('node', ['check.mjs'], { cwd: dir, stdio: 'inherit' })
} finally {
  rmSync(dir, { recursive: true, force: true })
}
