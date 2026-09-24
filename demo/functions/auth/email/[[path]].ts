/**
 * Passwordless sign-in by email: `emailCodeAuth`'s four handlers, mounted the
 * way `examples/pages-functions/auth/email/[[path]].ts` shows.
 *
 *   POST /auth/email/start   -> mail a magic link + 6-digit code (constant reply)
 *   POST /auth/email/code    -> verify the code, mint the session in this tab
 *   GET  /auth/email/verify  -> magic-link landing: mint + 302 to /dashboard
 *   GET  /auth/email/poll    -> original tab polls for the link being clicked
 *   GET  /auth/email/outbox  -> demo only, see below
 *
 * They sign into the same gate the dashboard checks, so an emailed code, a
 * and Google sign-in converge on one `gate.signIn`.
 *
 * **The dishonest step.** The library's `start` never says whether mail went
 * out — the reply is identical for an admitted and a not-admitted address, so
 * it can't be an allowlist oracle — and delivery *is* the verification: a link
 * that arrives in your inbox proves the address is yours. This demo has no
 * mail domain for most visitors, so its `send` captures the message instead of
 * sending it, stashes it in a short-lived HttpOnly cookie only this browser
 * can read back (`/auth/email/outbox`), and the page shows you the code and
 * link. That proves nothing, and the page says so. Mail really goes out only
 * to domains the operator listed in `MAIL_DOMAINS`.
 */
import { type SendEmail, emailCodeAuth } from '@open-athena/auth'
import { d1PendingAuthStore } from '@open-athena/auth/d1'
import { resendEmail } from '@open-athena/auth/resend'
import { type Env, gates, json, mailable } from '../../_lib/gates.js'

/** Pages passes the full EventContext; `waitUntil` keeps `start`'s latency constant. */
interface Ctx {
  request: Request
  env: Env
  waitUntil?: (p: Promise<unknown>) => void
}

/** What the outbox cookie carries: either "really sent" or the captured message. */
export interface Outbox {
  email: string
  /** True when a real mail went out (and so nothing is shown here). */
  sent: boolean
  code?: string
  link?: string
  at: number
}

const COOKIE = 'oa_demo_mail'
/** Matches the code's own TTL. */
const COOKIE_TTL_S = 900

const readCookie = (req: Request, name: string): string | null => {
  for (const part of (req.headers.get('cookie') ?? '').split(/;\s*/)) {
    if (part.startsWith(`${name}=`)) return part.slice(name.length + 1)
  }
  return null
}

const outboxCookie = (box: Outbox): string =>
  `${COOKIE}=${encodeURIComponent(JSON.stringify(box))}; Path=/auth/email; Max-Age=${COOKIE_TTL_S}; HttpOnly; SameSite=Lax`

const parseOutbox = (raw: string | null): Outbox | null => {
  if (!raw) return null
  try {
    const v = JSON.parse(decodeURIComponent(raw)) as Partial<Outbox>
    return typeof v.email === 'string' && typeof v.sent === 'boolean' && typeof v.at === 'number' ? (v as Outbox) : null
  } catch {
    return null
  }
}

export const onRequest = async ({ request, env, waitUntil }: Ctx): Promise<Response> => {
  const url = new URL(request.url)
  const route = url.pathname.slice('/auth/email/'.length)

  if (route === 'outbox' && request.method === 'GET') {
    const box = parseOutbox(readCookie(request, COOKIE))
    return box ? json(box) : json({ error: 'nothing in the outbox' }, 404)
  }

  const { viewGate } = gates(env, request)
  const nowS = Math.floor(Date.now() / 1000)
  const resend = env.RESEND_API_KEY && env.MAIL_FROM ? resendEmail({ apiKey: env.RESEND_API_KEY, from: env.MAIL_FROM }) : null

  // `send` is invoked synchronously inside `start` — before `start` resolves —
  // so by the time we read `captured.box` below it is settled, even when the
  // real delivery itself was scheduled via `waitUntil`.
  const captured: { box: Outbox | null } = { box: null }
  const send: SendEmail = async msg => {
    const to = Array.isArray(msg.to) ? msg.to[0]! : msg.to
    if (resend && mailable(to, env)) {
      captured.box = { email: to, sent: true, at: nowS }
      return resend(msg)
    }
    captured.box = {
      email: to,
      sent: false,
      code: msg.text.match(/^\s+(\d{6})$/m)?.[1],
      link: msg.text.match(/^(https?:\/\/\S+)$/m)?.[1],
      at: nowS,
    }
    return { ok: true }
  }

  const handlers = emailCodeAuth({
    gate: viewGate,
    store: d1PendingAuthStore(env.DB),
    send,
    from: env.MAIL_FROM ?? 'the @open-athena/auth demo <noreply@localhost>',
    // The magic link lands on this same mount's `verify` route, then on the dashboard.
    linkFor: token => `${url.origin}/auth/email/verify?token=${encodeURIComponent(token)}&next=%2Fdashboard`,
    appName: 'the @open-athena/auth demo',
    defaultNext: '/dashboard',
  })

  switch (route) {
    case 'start': {
      // The library consumes the body; keep the address so a start that sent
      // nothing (rate-limited, not admitted) still records what was asked.
      const asked = ((await request.clone().json().catch(() => ({}))) as { email?: unknown }).email
      const res = await handlers.start({ request, waitUntil })
      const box: Outbox = captured.box ?? {
        email: typeof asked === 'string' ? asked.trim().toLowerCase() : '',
        sent: false,
        at: nowS,
      }
      const headers = new Headers(res.headers)
      headers.append('set-cookie', outboxCookie(box))
      return new Response(res.body, { status: res.status, headers })
    }
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
