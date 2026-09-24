/**
 * The gated data — stand-in for whatever dashboard an adopter is protecting.
 * There is nothing to see here on purpose: the page's subject is the identity
 * the gate resolved, not a table of invented figures. What matters is the shape
 * of the handler — one `authenticate()` call, one scope check — and that,
 * because grant-backed sessions re-join their grant row on every request, a
 * link revoked a second ago fails *this* fetch. The dashboard polls it so the
 * fall back to the wall is visible without a reload.
 *
 * `logView: false`: the poll is plumbing. Page views come from the router's
 * beacon, which knows which route was actually read.
 */
import { hasScope } from '@open-athena/auth'
import { type Env, VIEW_SCOPE, gates, json } from '../../_lib/gates.js'

interface Ctx {
  request: Request
  env: Env
}

export const onRequest = async ({ request, env }: Ctx): Promise<Response> => {
  const { viewGate } = gates(env, request)
  const auth = await viewGate.authenticate(request, undefined, { logView: false })
  if (!auth) return json({ error: 'unauthenticated' }, 401)
  if (!hasScope(auth, VIEW_SCOPE)) return json({ error: 'forbidden' }, 403)
  return json({ ok: true, at: Math.floor(Date.now() / 1000) })
}
