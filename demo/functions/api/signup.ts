/**
 * "Sign in with email", accepting any address.
 *
 * This is the flow people don't realise the library already solves: an
 * `anyEmailPolicy` turns request-access into passwordless sign-up — no password
 * store, no account table, no IdP. The address is auto-approved, a grant bound
 * to it is minted, and it is *delivered by email*, which is what makes typing
 * someone else's address pointless rather than dangerous.
 *
 * The demo has no mail provider, so it returns the link directly. That is the
 * one dishonest step here, and it is called out in the UI: the real flow puts
 * this URL in an inbox, which is what makes it proof of address.
 */
import { anyEmailPolicy, createGate } from '@open-athena/auth'
import { d1AuditSink, d1GrantStore, d1RequestStore } from '@open-athena/auth/d1'
import { type Env, VIEW_COOKIE, VIEW_SCOPE, gates, json } from '../_lib/gates.js'

interface Ctx {
  request: Request
  env: Env
}

export const onRequestPost = async ({ request, env }: Ctx): Promise<Response> => {
  const { secret } = gates(env, request)
  let delivered: string | null = null

  // A second gate over the same store, differing only in policy: anyone at all,
  // rather than staff-only. `notify` is where the link would meet an ESP.
  const signupGate = createGate({
    store: d1GrantStore(env.DB),
    requests: d1RequestStore(env.DB),
    audit: d1AuditSink(env.DB),
    secret,
    cookieName: VIEW_COOKIE,
    policy: anyEmailPolicy([VIEW_SCOPE]),
    approvalGrant: { scopes: [VIEW_SCOPE], expiresInS: 7 * 86400 },
    notify: async e => {
      if (e.kind === 'access-granted') delivered = e.token
    },
  })

  const { email } = (await request.json().catch(() => ({}))) as { email?: string }
  if (!email) return json({ error: 'email required' }, 400)

  const res = await signupGate.requestAccess({ email }, request)
  if (res.status === 'invalid') return json({ error: "that doesn't look like an email address" }, 400)
  if (res.status === 'rate-limited') return json({ error: 'too many sign-ups from here; try later' }, 429)
  if (!delivered) return json({ error: 'no link was issued' }, 500)

  const url = new URL(request.url)
  return json({ url: `${url.origin}/dashboard?key=${delivered}`, email })
}
