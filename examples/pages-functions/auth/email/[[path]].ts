/**
 * Reference Pages-Function mount for `emailCodeAuth`'s four handlers — copy this
 * file into your project's `functions/auth/email/` and adjust `Env`/`gateFor`.
 *
 *   POST /auth/email/start   -> email a magic link + 6-digit code (constant reply)
 *   POST /auth/email/code    -> verify the code, mint the session in this tab
 *   GET  /auth/email/verify  -> magic-link landing: mint + 302 to `next`
 *   GET  /auth/email/poll    -> original tab polls for the link being clicked
 *
 * Mounted at `/auth/email/*`, outside `authRoutes`' `/api/auth/*` surface, so
 * there's no route-precedence question. `EmailCodeForm` defaults to
 * `/api/auth/email/{start,code}`, so pass `startEndpoint`/`verifyEndpoint` to
 * match (or put this file under `functions/api/auth/email/` instead — Pages
 * routes the more specific path first).
 *
 * All four converge on the same `gate.signIn` as Google OIDC / CF Access: same
 * allowlist, sessions, scopes. Dormant (503) until `RESEND_API_KEY` and
 * `MAIL_FROM` are set — which `scripts/provision-resend.mjs` does — so the file
 * can ship before the domain is provisioned.
 */
import { createGate, emailCodeAuth } from '@open-athena/auth'
import { d1AuditSink, d1GrantStore, d1PendingAuthStore } from '@open-athena/auth/d1'
import { resendEmail } from '@open-athena/auth/resend'
import type { D1Database } from '@cloudflare/workers-types'

export interface Env {
  DB: D1Database
  SESSION_SECRET: string
  /** Set by `provision-resend.mjs`'s `secrets` step. Absent → these routes 503. */
  RESEND_API_KEY?: string
  /** `noreply@your.domain` or `App <noreply@your.domain>`, at the verified domain. */
  MAIL_FROM?: string
  /** Shown in the mail's subject and body. */
  APP_NAME?: string
}

/** Pages passes the full EventContext; `waitUntil` keeps `start`'s latency constant. */
interface Ctx {
  request: Request
  env: Env
  waitUntil?: (p: Promise<unknown>) => void
}

/** Your app's gate — the same one every other auth path uses. */
const gateFor = (env: Env) =>
  createGate({
    store: d1GrantStore(env.DB),
    audit: d1AuditSink(env.DB),
    secret: env.SESSION_SECRET,
    // policy: allowlistPolicy(d1Allowlist(env.DB)), domainPolicy([...]), ...
  })

export const onRequest = async ({ request, env, waitUntil }: Ctx): Promise<Response> => {
  if (!env.DB || !env.SESSION_SECRET || !env.RESEND_API_KEY || !env.MAIL_FROM) {
    return new Response('email-code auth not configured (DB / SESSION_SECRET / RESEND_API_KEY / MAIL_FROM)\n', { status: 503 })
  }
  const origin = new URL(request.url).origin
  const handlers = emailCodeAuth({
    gate: gateFor(env),
    store: d1PendingAuthStore(env.DB),
    send: resendEmail({ apiKey: env.RESEND_API_KEY, from: env.MAIL_FROM }),
    from: env.MAIL_FROM,
    // The magic link lands on this same mount's `verify` route.
    linkFor: token => `${origin}/auth/email/verify?token=${encodeURIComponent(token)}`,
    appName: env.APP_NAME,
  })
  switch (new URL(request.url).pathname.split('/').pop()) {
    case 'start':
      return handlers.start({ request, waitUntil })
    case 'code':
      return handlers.verifyCode({ request })
    case 'verify':
      return handlers.verifyLink({ request })
    case 'poll':
      return handlers.poll({ request })
    default:
      return new Response('not found\n', { status: 404 })
  }
}
