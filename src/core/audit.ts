/**
 * The access log. `authenticate()` runs on every gated request, so it is the
 * natural single emit point — and "who viewed what" then joins to `grants`
 * natively instead of across two systems (see specs/share-links-and-audit.md §4).
 *
 * Volume control is two-tier: auth-lifecycle events (`mint`/`redeem`/`deny`/
 * `revoke`/`request`/`signin`/`signout`) always log; `view` events are deduped
 * per (session, path, hour) by the adapter, and are off by default.
 */
import { hashIp } from './tokens.js'

export type AccessEventKind = 'mint' | 'redeem' | 'deny' | 'revoke' | 'request' | 'view' | 'signin' | 'signout'

export interface AccessEvent {
  ts: number // epoch seconds
  event: AccessEventKind
  grantId?: string | null
  sessionSub?: string | null
  path?: string | null
  status?: number | null
  /** HMAC of the client IP — correlate sessions without retaining addresses. */
  ipHash?: string | null
  ua?: string | null
  country?: string | null
  referer?: string | null
  /**
   * Event detail. On `deny`: `expired`, `revoked`, `exhausted`, `bad-token`,
   * `not-allowed`. On `mint`: the actor, when it isn't an email (`policy`) and
   * so can't be a `sessionSub`.
   */
  reason?: string | null
}

export interface AuditSink {
  log(event: AccessEvent): Promise<void>
}

/** Drops everything. The default when an app hasn't wired a store. */
export const nullAudit: AuditSink = { log: async () => {} }

export interface RequestMeta {
  path: string
  ipHash: string | null
  ua: string | null
  country: string | null
  referer: string | null
}

/**
 * Pull the loggable request metadata. Header-based (not `request.cf`) so this
 * stays runtime-agnostic; CF populates `CF-Connecting-IP`/`CF-IPCountry` for free.
 */
export async function requestMeta(req: Request, ipSecret: string): Promise<RequestMeta> {
  const h = req.headers
  const ip = h.get('CF-Connecting-IP') ?? h.get('X-Forwarded-For')?.split(',')[0]?.trim() ?? null
  return {
    path: new URL(req.url).pathname,
    ipHash: ip ? await hashIp(ip, ipSecret) : null,
    ua: h.get('User-Agent'),
    country: h.get('CF-IPCountry'),
    referer: h.get('Referer'),
  }
}
