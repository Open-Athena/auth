/**
 * Two gates over one grants table.
 *
 * `viewGate` guards the dashboard — the thing a share link gets you into.
 * `adminGate` guards the console where links are minted, watched and revoked.
 * They use different cookie names, so a visitor can hold an admin session and a
 * recipient session at once, and the same D1 store, so revoking in the console
 * kills the dashboard session on its very next request. That single property is
 * most of what this demo exists to show.
 */
import { type AuditQuery, type EmailPolicy, createGate, domainPolicy, firstMatch } from '@open-athena/auth'
import { d1AuditQuery, d1AuditSink, d1GrantStore, d1RequestStore } from '@open-athena/auth/d1'

export interface Env {
  DB: D1Database
  SESSION_SECRET?: string
  ACCESS_TEAM_DOMAIN?: string
  ACCESS_AUD?: string
  STAFF_DOMAIN?: string
}

/** Ephemeral per-visitor identities live here; the TLD is reserved and unroutable. */
export const SANDBOX_DOMAIN = 'sandbox.invalid'

export const ADMIN_COOKIE = 'oa_demo_admin'
export const VIEW_COOKIE = 'oa_demo_view'

/** Scope for the dashboard's data. */
export const VIEW_SCOPE = 'reports'
/** Scope for minting/revoking your own links. */
export const ADMIN_SCOPE = 'admin'
/** Scope for reading the access-request queue — staff only, since it holds strangers' emails. */
export const REQUESTS_SCOPE = 'requests'

/**
 * A fixed dev secret, used only when the request is to localhost and no real
 * secret is configured — so `pnpm dev` works with zero setup while a deployed
 * instance without `SESSION_SECRET` still fails loudly.
 */
function secretFor(env: Env, req: Request): string {
  if (env.SESSION_SECRET) return env.SESSION_SECRET
  const { hostname } = new URL(req.url)
  if (hostname === 'localhost' || hostname === '127.0.0.1') return 'dev-only-insecure-secret-do-not-ship'
  throw new Error('SESSION_SECRET is not configured')
}

const sandboxPolicy = (scopes: string[]): EmailPolicy => email =>
  email.endsWith(`@${SANDBOX_DOMAIN}`) ? scopes : null

export function gates(env: Env, req: Request) {
  const secret = secretFor(env, req)
  const store = d1GrantStore(env.DB)
  const requests = d1RequestStore(env.DB)
  const audit = d1AuditSink(env.DB)
  const staffDomain = env.STAFF_DOMAIN ?? 'openathena.ai'

  const viewGate = createGate({
    store,
    requests,
    audit,
    secret,
    cookieName: VIEW_COOKIE,
    // Staff get in via SSO; everyone else needs a link. Sandbox identities
    // deliberately do NOT match, so a visitor playing admin still meets the
    // wall and has to mint themselves a link to get through it.
    policy: domainPolicy([staffDomain], [VIEW_SCOPE]),
    approvalGrant: { scopes: [VIEW_SCOPE], expiresInS: 7 * 86400 },
    // On for the demo, because the access log is the point. A real app should
    // ship this switch together with the disclosure copy, never silently.
    logViews: true,
  })

  const adminGate = createGate({
    store,
    requests,
    audit,
    secret,
    cookieName: ADMIN_COOKIE,
    policy: firstMatch(
      domainPolicy([staffDomain], [ADMIN_SCOPE, REQUESTS_SCOPE, VIEW_SCOPE]),
      sandboxPolicy([ADMIN_SCOPE]),
    ),
    approvalGrant: { scopes: [VIEW_SCOPE], expiresInS: 7 * 86400 },
  })

  return { viewGate, adminGate, auditQuery: d1AuditQuery(env.DB) as AuditQuery, staffDomain, secret }
}

export const json = (data: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(data, null, 2) + '\n', {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  })
