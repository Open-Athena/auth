/**
 * Promote a staff Google sign-in to the admin gate.
 *
 * Google sign-in lands in `viewGate` (one registered redirect URI serves both
 * gates). The admin page then POSTs here: if the view session is an email
 * session the *admin* gate's policy admits — the staff domain — this mints the
 * admin cookie for the same address. Anyone else gets a 403, and a sandbox
 * never reaches this (it has no view session).
 */
import { type Env, gates, json } from '../_lib/gates.js'

interface Ctx {
  request: Request
  env: Env
}

export const onRequestPost = async ({ request, env }: Ctx): Promise<Response> => {
  const { viewGate, adminGate } = gates(env, request)
  const auth = await viewGate.authenticate(request, undefined, { logView: false })
  if (!auth || auth.kind !== 'sso') return json({ error: 'sign in first' }, 401)
  const signedIn = await adminGate.signIn(auth.email, request)
  if (!signedIn) return json({ error: 'not staff' }, 403)
  return json({ ok: true, email: auth.email }, 200, { 'set-cookie': signedIn.cookie })
}
