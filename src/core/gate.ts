/**
 * The gate: sessions and grants as peers.
 *
 * An SSO sign-in and a share link both end at the same first-party session
 * cookie; the only difference is the `sub` it carries. Grant-backed sessions
 * re-join their grant row on *every* request, so revoking a link kills every
 * session it ever minted, instantly — that property is what makes the social
 * story (assume forwarding; make it visible and revocable) actually work.
 */
import { type AccessEvent, type AuditSink, nullAudit, requestMeta } from './audit.js'
import { type EmailPolicy, adminPolicy, firstMatch } from './policy.js'
import {
  type AccessRequest,
  DEFAULT_RATE_LIMIT,
  type Notify,
  type RateLimit,
  isEmailish,
  noopNotify,
} from './requests.js'
import {
  DEFAULT_COOKIE_NAME,
  DEFAULT_SESSION_TTL_S,
  clearCookie,
  emailSub,
  grantSub,
  isSecureRequest,
  parseSub,
  readCookie,
  sessionCookie,
  signSession,
  verifySession,
} from './session.js'
import type { GrantListOpts, GrantStore, RequestListOpts, RequestStore } from './store.js'
import { ALL_SCOPES, type Auth, type Grant, type NewGrant } from './types.js'
import { generateId, generateToken, hashToken } from './tokens.js'

export interface GateOptions {
  store: GrantStore
  /** HMAC key for session cookies and IP hashing. */
  secret: string
  /** Which SSO identities are allowed, and what scopes they get. Default: admins only. */
  policy?: EmailPolicy
  /** Always allowed, always `*`. Checked ahead of `policy`. */
  adminEmails?: readonly string[]
  cookieName?: string
  sessionTtlS?: number
  audit?: AuditSink
  /** Skip redundant `last_used_at` writes within this window. Default 60s. */
  touchIntervalS?: number
  /**
   * Log a `view` event per authenticated request (deduped per session/path/hour).
   * Off by default: the privacy-forward default, to be turned on alongside the
   * "access is logged" disclosure copy rather than silently.
   */
  logViews?: boolean
  /** Enables the request-access flow. Without it, `requestAccess` throws. */
  requests?: RequestStore
  /** Where approvals and notifications go. Default: nowhere. */
  notify?: Notify
  rateLimit?: RateLimit
  /** Shape of the grant minted when a request is approved. */
  approvalGrant?: {
    scopes?: string[]
    expiresInS?: number | null
    maxRedeems?: number | null
    sessionTtlS?: number | null
  }
}

export type RedeemFailure = 'bad-token' | 'revoked' | 'expired' | 'exhausted'

export type RequestAccessResult =
  /** Policy matched: a grant was minted and handed to `notify` immediately. */
  | { status: 'auto'; request: AccessRequest; grant: Grant; token: string }
  /** Waiting on an admin. Also returned for a re-submit, with the original row. */
  | { status: 'pending'; request: AccessRequest }
  | { status: 'invalid' }
  | { status: 'rate-limited' }

export type RedeemResult =
  | { ok: true; grant: Grant; auth: Auth; cookie: string }
  | { ok: false; reason: RedeemFailure }

export interface MintResult {
  grant: Grant
  /** The raw token. Returned exactly once — only its hash is stored. */
  token: string
}

const sec = (nowMs: number): number => Math.floor(nowMs / 1000)

/** Active = not revoked, not expired. Redemption caps are checked only at redeem time. */
export function isActive(grant: Grant, nowS: number): boolean {
  return grant.revokedAt === null && (grant.expiresAt === null || grant.expiresAt > nowS)
}

function grantAuth(grant: Grant): Auth {
  return { kind: 'grant', grant, admin: false, scopes: grant.scopes }
}

export function createGate(opts: GateOptions) {
  const {
    store,
    secret,
    adminEmails = [],
    cookieName = DEFAULT_COOKIE_NAME,
    sessionTtlS = DEFAULT_SESSION_TTL_S,
    audit = nullAudit,
    touchIntervalS = 60,
    logViews = false,
  } = opts
  const policy: EmailPolicy = opts.policy
    ? firstMatch(adminPolicy(adminEmails), opts.policy)
    : adminPolicy(adminEmails)
  const isAdmin = (email: string): boolean => adminEmails.some(a => a.toLowerCase() === email.toLowerCase())

  const notify: Notify = opts.notify ?? noopNotify
  const log = (event: AccessEvent): Promise<void> => audit.log(event)

  async function logWithRequest(req: Request, event: Omit<AccessEvent, 'ts' | 'path'>, nowS: number): Promise<void> {
    const meta = await requestMeta(req, secret)
    await log({ ts: nowS, ...meta, ...event })
  }

  function cookieFor(req: Request, value: string, ttlS: number): string {
    return sessionCookie(value, { name: cookieName, ttlS, secure: isSecureRequest(req) })
  }

  /**
   * Resolve the request's identity from (in order) a `?key=`/`Bearer` token or
   * the session cookie. The token forms let curl and scripts skip the cookie
   * exchange; they are request-scoped and never count as a redemption, since a
   * redemption means "a browser session was minted".
   */
  async function authenticate(req: Request, nowMs = Date.now()): Promise<Auth | null> {
    const nowS = sec(nowMs)
    const url = new URL(req.url)
    const presented = req.headers.get('Authorization')?.match(/^Bearer (.+)$/)?.[1] ?? url.searchParams.get('key')

    if (presented) {
      const grant = await store.byTokenHash(await hashToken(presented))
      if (!grant) {
        await logWithRequest(req, { event: 'deny', reason: 'bad-token' }, nowS)
        return null
      }
      if (!isActive(grant, nowS)) {
        await logWithRequest(req, { event: 'deny', grantId: grant.id, reason: grant.revokedAt ? 'revoked' : 'expired' }, nowS)
        return null
      }
      await store.touch(grant.id, nowS, touchIntervalS)
      return await afterAuth(req, grantAuth(grant), nowS)
    }

    const cookie = readCookie(req, cookieName)
    if (!cookie) return null
    const sub = await verifySession(cookie, secret, nowMs)
    if (!sub) return null
    const parsed = parseSub(sub)
    if (!parsed) return null

    if (parsed.kind === 'email') {
      const scopes = await policy(parsed.value)
      if (!scopes) {
        await logWithRequest(req, { event: 'deny', sessionSub: sub, reason: 'not-allowed' }, nowS)
        return null
      }
      return await afterAuth(req, { kind: 'sso', email: parsed.value, admin: isAdmin(parsed.value), scopes }, nowS)
    }

    // Re-join the grant every request: this is what makes revocation instant.
    const grant = await store.byId(parsed.value)
    if (!grant || !isActive(grant, nowS)) {
      await logWithRequest(req, { event: 'deny', grantId: parsed.value, sessionSub: sub, reason: grant?.revokedAt ? 'revoked' : 'expired' }, nowS)
      return null
    }
    await store.touch(grant.id, nowS, touchIntervalS)
    return await afterAuth(req, grantAuth(grant), nowS)
  }

  async function afterAuth(req: Request, auth: Auth, nowS: number): Promise<Auth> {
    if (logViews) await logView(req, auth, nowS)
    return auth
  }

  async function logView(req: Request, auth: Auth, nowS = sec(Date.now())): Promise<void> {
    await logWithRequest(
      req,
      auth.kind === 'grant'
        ? { event: 'view', grantId: auth.grant.id, sessionSub: grantSub(auth.grant.id) }
        : { event: 'view', sessionSub: emailSub(auth.email) },
      nowS,
    )
  }

  /** `?key=<token>` -> session cookie. This is the one path that spends a redemption. */
  async function redeem(token: string, req: Request, nowMs = Date.now()): Promise<RedeemResult> {
    const nowS = sec(nowMs)
    const existing = await store.byTokenHash(await hashToken(token))
    if (!existing) {
      await logWithRequest(req, { event: 'deny', reason: 'bad-token' }, nowS)
      return { ok: false, reason: 'bad-token' }
    }
    const grant = await store.redeem(existing.id, nowS)
    if (!grant) {
      const reason: RedeemFailure = existing.revokedAt
        ? 'revoked'
        : existing.expiresAt !== null && existing.expiresAt <= nowS
          ? 'expired'
          : 'exhausted'
      await logWithRequest(req, { event: 'deny', grantId: existing.id, reason }, nowS)
      return { ok: false, reason }
    }
    const ttlS = grant.sessionTtlS ?? sessionTtlS
    const cookie = cookieFor(req, await signSession(grantSub(grant.id), secret, nowMs, ttlS), ttlS)
    await logWithRequest(req, { event: 'redeem', grantId: grant.id, sessionSub: grantSub(grant.id) }, nowS)
    return { ok: true, grant, auth: grantAuth(grant), cookie }
  }

  /** Mint a session for an identity an IdP just vouched for. Null if policy denies. */
  async function signIn(email: string, req: Request, nowMs = Date.now()): Promise<{ auth: Auth; cookie: string } | null> {
    const nowS = sec(nowMs)
    const scopes = await policy(email)
    if (!scopes) {
      await logWithRequest(req, { event: 'deny', sessionSub: emailSub(email), reason: 'not-allowed' }, nowS)
      return null
    }
    const cookie = cookieFor(req, await signSession(emailSub(email), secret, nowMs, sessionTtlS), sessionTtlS)
    await logWithRequest(req, { event: 'signin', sessionSub: emailSub(email) }, nowS)
    return { auth: { kind: 'sso', email, admin: isAdmin(email), scopes }, cookie }
  }

  async function signOut(req: Request, auth: Auth | null = null, nowMs = Date.now()): Promise<string> {
    await logWithRequest(
      req,
      { event: 'signout', sessionSub: auth?.kind === 'sso' ? emailSub(auth.email) : auth ? grantSub(auth.grant.id) : null },
      sec(nowMs),
    )
    return clearCookie({ name: cookieName, secure: isSecureRequest(req) })
  }

  async function mint(draft: NewGrant, nowMs = Date.now()): Promise<MintResult> {
    const nowS = sec(nowMs)
    const token = generateToken()
    const grant: Grant = {
      id: generateId(),
      name: draft.name ?? null,
      note: draft.note ?? null,
      subject: draft.subject ?? null,
      email: draft.email ?? null,
      scopes: draft.scopes,
      maxRedeems: draft.maxRedeems ?? null,
      redeems: 0,
      expiresAt: draft.expiresAt ?? null,
      sessionTtlS: draft.sessionTtlS ?? null,
      createdAt: nowS,
      createdBy: draft.createdBy,
      revokedAt: null,
      firstUsedAt: null,
      lastUsedAt: null,
    }
    await store.insert(grant, await hashToken(token))
    return { grant, token }
  }

  function requestStore(): RequestStore {
    if (!opts.requests) throw new Error('request-access is not configured: pass `requests` to createGate')
    return opts.requests
  }

  /** Mint the grant an approval delivers, and hand it to `notify` with its token. */
  async function grantFor(request: AccessRequest, scopes: string[], createdBy: string, nowMs: number) {
    const { expiresInS = null, maxRedeems = null, sessionTtlS = null } = opts.approvalGrant ?? {}
    return mint(
      {
        name: request.name ?? request.email,
        note: request.note,
        email: request.email,
        scopes,
        maxRedeems,
        expiresAt: expiresInS === null ? null : sec(nowMs) + expiresInS,
        sessionTtlS,
        createdBy,
      },
      nowMs,
    )
  }

  async function requestAccess(
    input: { email: string; name?: string | null; note?: string | null },
    req: Request,
    nowMs = Date.now(),
  ): Promise<RequestAccessResult> {
    const requests = requestStore()
    const nowS = sec(nowMs)
    const email = input.email.trim().toLowerCase()
    if (!isEmailish(email)) return { status: 'invalid' }

    const limits = { ...DEFAULT_RATE_LIMIT, ...opts.rateLimit }
    const meta = await requestMeta(req, secret)
    const since = nowS - limits.windowS
    const [byEmail, byIp] = await Promise.all([
      requests.countSince(since, { email }),
      meta.ipHash ? requests.countSince(since, { ipHash: meta.ipHash }) : Promise.resolve(0),
    ])
    if (byEmail >= limits.perEmail || byIp >= limits.perIp) return { status: 'rate-limited' }

    // A re-visit should show "pending", not queue a second row for an admin.
    const open = await requests.pendingByEmail(email)
    if (open) return { status: 'pending', request: open }

    const autoScopes = await policy(email)
    const request: AccessRequest = {
      id: generateId(),
      email,
      name: input.name?.trim() || null,
      note: input.note?.trim() || null,
      createdAt: nowS,
      status: autoScopes ? 'auto' : 'pending',
      decidedAt: autoScopes ? nowS : null,
      decidedBy: autoScopes ? 'policy' : null,
      grantId: null,
    }

    if (autoScopes) {
      const { grant, token } = await grantFor(request, autoScopes, 'policy', nowMs)
      request.grantId = grant.id
      await requests.insert(request, meta.ipHash)
      await log({ ts: nowS, ...meta, event: 'request', grantId: grant.id, sessionSub: emailSub(email) })
      await notify({ kind: 'access-granted', request, grant, token })
      return { status: 'auto', request, grant, token }
    }

    await requests.insert(request, meta.ipHash)
    await log({ ts: nowS, ...meta, event: 'request', sessionSub: emailSub(email) })
    await notify({ kind: 'access-requested', request })
    return { status: 'pending', request }
  }

  /** Approve a pending request: mint a grant bound to its email and deliver it. */
  async function approveRequest(
    id: string,
    approvedBy: string,
    override: { scopes?: string[] } = {},
    nowMs = Date.now(),
  ): Promise<{ request: AccessRequest; grant: Grant; token: string } | null> {
    const requests = requestStore()
    const nowS = sec(nowMs)
    const existing = await requests.byId(id)
    if (!existing || existing.status !== 'pending') return null
    const scopes = override.scopes ?? opts.approvalGrant?.scopes ?? []
    const { grant, token } = await grantFor(existing, scopes, approvedBy, nowMs)
    const request = await requests.decide(id, { status: 'approved', decidedBy: approvedBy, grantId: grant.id, nowS })
    if (!request) {
      // Another admin decided it in between; don't leave the grant usable.
      await store.revoke(grant.id, nowS)
      return null
    }
    await notify({ kind: 'access-granted', request, grant, token })
    return { request, grant, token }
  }

  async function denyRequest(id: string, deniedBy: string, nowMs = Date.now()): Promise<AccessRequest | null> {
    const request = await requestStore().decide(id, {
      status: 'denied',
      decidedBy: deniedBy,
      grantId: null,
      nowS: sec(nowMs),
    })
    if (request) await notify({ kind: 'access-denied', request })
    return request
  }

  async function revoke(id: string, nowMs = Date.now()): Promise<boolean> {
    const nowS = sec(nowMs)
    const ok = await store.revoke(id, nowS)
    if (ok) await log({ ts: nowS, event: 'revoke', grantId: id })
    return ok
  }

  /** The JSON an app hands its frontend. Never includes tokens or hashes. */
  function whoami(auth: Auth) {
    return auth.kind === 'sso'
      ? { kind: 'sso' as const, email: auth.email, admin: auth.admin, scopes: auth.scopes }
      : {
          kind: 'grant' as const,
          name: auth.grant.name,
          subject: auth.grant.subject,
          email: auth.grant.email,
          scopes: auth.scopes,
          admin: false,
          expiresAt: auth.grant.expiresAt,
        }
  }

  return {
    authenticate,
    redeem,
    signIn,
    signOut,
    mint,
    revoke,
    logView,
    whoami,
    isAdmin,
    cookieName,
    requestAccess,
    approveRequest,
    denyRequest,
    list: (o?: GrantListOpts) => store.list(o),
    listRequests: (o?: RequestListOpts) => requestStore().list(o),
  }
}

export type Gate = ReturnType<typeof createGate>

export { ALL_SCOPES }
