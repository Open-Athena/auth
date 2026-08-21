/**
 * "Sign in with email", accepting any address.
 *
 * This is the flow people don't realise the library already solves: an
 * `anyEmailPolicy` turns request-access into passwordless sign-up — no password
 * store, no account table, no IdP. The address is auto-approved, a grant bound
 * to it is minted, and it is *delivered by email*, which is what makes typing
 * someone else's address pointless rather than dangerous.
 *
 * Mail is only sent to domains the operator listed in `MAIL_DOMAINS`. That is
 * not timidity: a public form that emails any address a stranger types is an
 * unsolicited-mail cannon aimed at third parties, and one visitor could burn a
 * 100/day quota — and the sending domain's reputation with it — in a minute.
 * Everyone else gets the link on screen, with the UI saying plainly that
 * handing it back is the one step a real deployment doesn't do.
 */
import { anyEmailPolicy, createGate, emailNotify } from '@open-athena/auth'
import { d1AuditSink, d1GrantStore, d1RequestStore } from '@open-athena/auth/d1'
import { resendEmail } from '@open-athena/auth/resend'
import { type Env, VIEW_COOKIE, VIEW_SCOPE, gates, json } from '../_lib/gates.js'

interface Ctx {
  request: Request
  env: Env
}

const mailable = (email: string, env: Env): boolean => {
  if (!env.RESEND_API_KEY || !env.MAIL_FROM) return false
  const domains = (env.MAIL_DOMAINS ?? '')
    .split(',')
    .map(d => d.trim().toLowerCase())
    .filter(Boolean)
  const at = email.lastIndexOf('@')
  return at > 0 && domains.includes(email.slice(at + 1).toLowerCase())
}

export const onRequestPost = async ({ request, env }: Ctx): Promise<Response> => {
  const { email } = (await request.json().catch(() => ({}))) as { email?: string }
  if (!email) return json({ error: 'email required' }, 400)

  const { secret } = gates(env, request)
  const origin = new URL(request.url).origin
  const linkFor = (token: string) => `${origin}/dashboard?key=${token}`
  const send = mailable(email, env)

  let delivered: string | null = null
  let mailError: string | null = null

  // A second gate over the same store, differing only in policy: anyone at all,
  // rather than staff-only.
  const signupGate = createGate({
    store: d1GrantStore(env.DB),
    requests: d1RequestStore(env.DB),
    audit: d1AuditSink(env.DB),
    secret,
    cookieName: VIEW_COOKIE,
    policy: anyEmailPolicy([VIEW_SCOPE]),
    approvalGrant: { scopes: [VIEW_SCOPE], expiresInS: 7 * 86400 },
    notify: send
      ? emailNotify({
          send: resendEmail({ apiKey: env.RESEND_API_KEY! }),
          from: env.MAIL_FROM!,
          appName: 'the @open-athena/auth demo',
          linkFor,
          onError: e => {
            mailError = e
          },
        })
      : async e => {
          if (e.kind === 'access-granted') delivered = e.token
        },
  })

  const res = await signupGate.requestAccess({ email }, request)
  if (res.status === 'invalid') return json({ error: "that doesn't look like an email address" }, 400)
  if (res.status === 'rate-limited') return json({ error: 'too many sign-ups from here; try later' }, 429)

  // A send failure is reported, not swallowed: "check your inbox" when nothing
  // was sent is the worst answer this endpoint could give.
  if (mailError) return json({ error: `couldn't send the mail (${mailError})` }, 502)
  if (send) return json({ sent: true, email })
  if (!delivered) return json({ error: 'no link was issued' }, 500)
  return json({ url: linkFor(delivered), email })
}
