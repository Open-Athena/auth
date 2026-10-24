/**
 * `@open-athena/auth/session-log`: optional, time-boxed user-action logging
 * for reproducing a reported bug. Off by default; an admin switches it on for
 * a few days (at most 31, or explicitly with no end date) and reads each
 * session's event timeline. The D1 store is `@open-athena/auth/session-log/d1`
 * (migration `migrations/session-log/`), the browser logger
 * `@open-athena/auth/session-log/client`, the admin UI
 * `@open-athena/auth/react/session-log`.
 */
import type { Gate } from '../core/gate.js'
import { hasScope } from '../core/types.js'
import type { SessionLogWho } from './store.js'

export * from '../core/session-log-shape.js'
export * from './store.js'
export { sessionLogRoutes, type SessionLogCtx, type SessionLogRoutesOptions } from './routes.js'

export interface FromGateOptions {
  /** The scope that may read sessions and flip the switch (default `'admin'`). */
  adminScope?: string
  /**
   * Log visitors with no session too (a public site), as `{email: null, via: 'public'}`.
   * Off by default: only signed-in viewers are logged.
   */
  anonymous?: boolean
}

/**
 * `identify` and `requireAdmin` from an `@open-athena/auth` gate. A link
 * session is logged under its bound address when it has one (`via: 'grant'`),
 * else with no address; an SSO session under its email (`via: 'sso'`).
 */
export function fromGate(gate: Gate, opts: FromGateOptions = {}) {
  const { adminScope = 'admin', anonymous = false } = opts
  // `logView: false`: these are plumbing requests, not page views.
  const auth = (req: Request) => gate.authenticateResult(req, Date.now(), { logView: false })
  return {
    async identify(req: Request): Promise<SessionLogWho | null> {
      const a = (await auth(req)).auth
      if (!a) return anonymous ? { email: null, via: 'public' } : null
      return a.kind === 'sso' ? { email: a.email, via: 'sso' } : { email: a.grant.email, via: 'grant' }
    },
    async requireAdmin(req: Request): Promise<{ who: string } | Response> {
      const result = await auth(req)
      const a = result.auth
      if (!a) return gate.unauthenticated(req, result)
      if (!hasScope(a, adminScope)) {
        return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403, headers: { 'content-type': 'application/json' } })
      }
      return { who: a.kind === 'sso' ? a.email : (a.grant.email ?? a.grant.name ?? `grant:${a.grant.id}`) }
    },
  }
}
