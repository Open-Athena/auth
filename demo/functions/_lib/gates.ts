/**
 * Two gates over one grants table.
 *
 * `viewGate` guards the dashboard — the thing a share link, an emailed code or a
 * Google sign-in gets you into. `adminGate` guards the admin page where
 * links are minted, watched and revoked. They use different cookie names, so a
 * visitor can hold an admin session and a recipient session at once, and the
 * same D1 store, so revoking in the admin page kills the dashboard session on
 * its very next request. That single property is most of what this demo exists
 * to show.
 */
import { type AuditQuery, type EmailPolicy, createGate, domainPolicy, firstMatch } from '@open-athena/auth'
import { d1AuditQuery, d1AuditSink, d1GrantStore, d1ProfileStore, d1RequestStore } from '@open-athena/auth/d1'

export interface Env {
  DB: D1Database
  SESSION_SECRET?: string
  /** Sending-only Resend key. Absent = the demo shows codes and links instead of mailing them. */
  RESEND_API_KEY?: string
  /** `Name <addr@verified-domain>`. */
  MAIL_FROM?: string
  /**
   * Comma-separated recipient domains the demo will actually mail.
   *
   * Empty by default, and that default is load-bearing: a public form that
   * emails *any* address someone types is an unsolicited-mail cannon pointed
   * at third parties, and the free tier's 100/day would let one visitor burn
   * the quota and the sending domain's reputation with it. Addresses outside
   * this list get the code and link on screen, which is what the demo has
   * always done.
   */
  MAIL_DOMAINS?: string
  /**
   * Where access requests are announced. Unset = no admin mail.
   *
   * Deliberately independent of `MAIL_DOMAINS`: this address is the operator's
   * own, so there is no stranger to protect from it.
   */
  MAIL_ADMIN_TO?: string
  /** Google OAuth "Web application" client. Absent = `/auth/google/*` answers 503 and the buttons are inert. */
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  /** Google sign-ins at this domain may promote to the admin gate (`/api/staff`). */
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

const isSandbox = (email: string): boolean => email.endsWith(`@${SANDBOX_DOMAIN}`)

const sandboxPolicy = (scopes: string[]): EmailPolicy => email => (isSandbox(email) ? scopes : null)

/**
 * Anyone at all, except a sandbox identity. This is the "this demo accepts
 * anyone" line: a real deployment writes `domainPolicy`, `allowlistPolicy`, or
 * both here, and everything downstream — sessions, scopes, revocation — is the
 * same. Sandbox identities are excluded so a visitor playing admin still meets
 * the wall on the dashboard and has to mint themselves a link to get through.
 */
const anyoneButSandbox = (scopes: string[]): EmailPolicy => email => (isSandbox(email) ? null : scopes)

/**
 * Will the demo actually mail this address? Only with a sender configured *and*
 * the recipient's domain on the operator's short list; everyone else sees the
 * message on screen instead.
 */
export function mailable(email: string, env: Env): boolean {
  if (!env.RESEND_API_KEY || !env.MAIL_FROM) return false
  const domains = (env.MAIL_DOMAINS ?? '')
    .split(',')
    .map(d => d.trim().toLowerCase())
    .filter(Boolean)
  const at = email.lastIndexOf('@')
  return at > 0 && domains.includes(email.slice(at + 1).toLowerCase())
}

export function gates(env: Env, req: Request) {
  const secret = secretFor(env, req)
  const store = d1GrantStore(env.DB)
  const requests = d1RequestStore(env.DB)
  const audit = d1AuditSink(env.DB)
  const profiles = d1ProfileStore(env.DB)
  const staffDomain = env.STAFF_DOMAIN ?? 'openathena.ai'

  const viewGate = createGate({
    store,
    requests,
    audit,
    profiles,
    secret,
    cookieName: VIEW_COOKIE,
    // An email session (Google or an emailed code — both end in
    // `gate.signIn`) re-derives its scopes from this policy on every request,
    // so "who may sign in by email" is decided here and nowhere else.
    policy: firstMatch(domainPolicy([staffDomain], [VIEW_SCOPE]), anyoneButSandbox([VIEW_SCOPE])),
    approvalGrant: { scopes: [VIEW_SCOPE], expiresInS: 7 * 86400 },
    // On for the demo, because the access log is the point. A real app should
    // ship this switch together with the disclosure copy, never silently.
    logViews: true,
  })

  // Strangers' access requests go through *this* gate (`/api/admin/request`):
  // its policy doesn't admit them, so a request stays pending for the staff
  // queue rather than being auto-approved by the admit-anyone view policy.
  const adminGate = createGate({
    store,
    requests,
    audit,
    profiles,
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
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  })
