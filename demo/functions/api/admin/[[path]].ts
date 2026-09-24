/**
 * The admin API. Every grant read and write is confined to grants this identity
 * created (`scopeToCreator`), which is what lets strangers share one deployment
 * without seeing — or revoking — each other's links. Someone else's grant id
 * 404s rather than 403s, so ids stay unconfirmed.
 *
 * The allowlist routes (`/allowed`, `/allowed/sync`) ride the same mount. The
 * library can't scope those rows per creator — the table is keyed by email and
 * `list()` takes no filter — so the demo wraps the store instead (below), and
 * its "directory sync" is simulated: there is no Google service account here.
 */
import { type AllowEntry, type AllowlistStore, type Auth, authRoutes } from '@open-athena/auth'
import { d1Allowlist } from '@open-athena/auth/d1'
import { ADMIN_SCOPE, type Env, REQUESTS_SCOPE, VIEW_SCOPE, gates } from '../../_lib/gates.js'

interface Ctx {
  request: Request
  env: Env
}

const creatorOf = (auth: Auth): string => (auth.kind === 'sso' ? auth.email : `g:${auth.grant.id}`)

/** The group a real deployment would pull from Google; here, a fixed roster. */
const GROUP = 'staff@example.org'
const SOURCE = `sync:${GROUP}`
const ROSTER = ['ada@example.org', 'grace@example.org', 'linus@example.org', 'margaret@example.org', 'radia@example.org']

/**
 * A stand-in for `syncGroupsToAllowlist(store, { key, groups })`: same
 * `replaceSource` call, same `[{ group, source, count }]` result, but the
 * membership is a random subset of the roster rather than a Cloud Identity
 * read — so "Sync now" visibly changes the table, and a member dropping out
 * shows what a removed employee looks like one sync interval later.
 */
async function simulatedSync(store: AllowlistStore) {
  const shuffled = [...ROSTER].sort(() => Math.random() - 0.5)
  const members = shuffled.slice(0, 2 + Math.floor(Math.random() * (ROSTER.length - 1)))
  const updatedAt = Math.floor(Date.now() / 1000)
  const entries: AllowEntry[] = members.sort().map(email => ({
    email,
    scopes: [VIEW_SCOPE],
    source: SOURCE,
    note: 'simulated group member',
    addedBy: 'demo-sync',
    updatedAt,
  }))
  await store.replaceSource(SOURCE, entries)
  return [{ group: GROUP, source: SOURCE, count: entries.length }]
}

/**
 * A visitor sees the rows they added plus the synced group, and can remove only
 * their own. Synced rows are shared across sandboxes — the simulated group is
 * one group — and an email is the primary key, so two visitors adding the
 * same address share (and fight over) one row. Both are demo compromises: a
 * real deployment has one admin set and no sandboxes.
 */
function scopedAllowlist(store: AllowlistStore, creator: string | null): AllowlistStore {
  const visible = (e: AllowEntry): boolean => e.source === SOURCE || (creator !== null && e.addedBy === creator)
  return {
    lookup: email => store.lookup(email),
    list: async () => (await store.list()).filter(visible),
    put: entry => store.put(entry),
    remove: async email => {
      const row = (await store.list()).find(r => r.email === email)
      if (!row || !visible(row)) return false
      return store.remove(email)
    },
    replaceSource: (source, entries) => store.replaceSource(source, entries),
  }
}

export const onRequest = async ({ request, env }: Ctx): Promise<Response> => {
  const { adminGate, auditQuery } = gates(env, request)
  const store = d1Allowlist(env.DB)

  // Only the allowlist routes need to know who's asking *before* the handler
  // runs; everything else is confined inside `authRoutes` by `scopeToCreator`.
  let allowlist: AllowlistStore = store
  if (new URL(request.url).pathname.startsWith('/api/admin/allowed')) {
    const auth = await adminGate.authenticate(request, undefined, { logView: false })
    allowlist = scopedAllowlist(store, auth ? creatorOf(auth) : null)
  }

  const handle = authRoutes(adminGate, {
    basePath: '/api/admin',
    adminScope: ADMIN_SCOPE,
    requestScope: REQUESTS_SCOPE,
    audit: auditQuery,
    allowlist,
    // A real deployment: `run: () => syncGroupsToAllowlist(store, { key: env.GOOGLE_SA_KEY, groups: [...] })`.
    sync: { run: () => simulatedSync(store) },
    creatorOf,
    scopeToCreator: auth => (auth.kind === 'sso' ? auth.email : undefined),
  })
  return (await handle(request)) ?? new Response('not found\n', { status: 404 })
}
