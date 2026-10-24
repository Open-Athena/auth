/**
 * The session log (`@open-athena/auth/session-log`): off until a staff member
 * switches it on at `/admin`, then each signed-in tab records what it did, for
 * `/admin/sessions` to replay. Staff only on the read side (the `requests`
 * scope, like the access-request queue): a session's events name strangers'
 * addresses, and every demo visitor is a sandbox admin.
 *
 * One routes instance per isolate, so its switch cache and purge throttle
 * persist across requests; the gates are rebuilt per request, as everywhere
 * else in the demo.
 */
import { fromGate, sessionLogRoutes } from '@open-athena/auth/session-log'
import { d1SessionLogStore } from '@open-athena/auth/session-log/d1'
import { type Env, REQUESTS_SCOPE, gates } from '../../_lib/gates.js'

interface Ctx {
  request: Request
  env: Env
  waitUntil: (p: Promise<unknown>) => void
}

let handle: ReturnType<typeof sessionLogRoutes> | null = null
let envOf: Env | null = null

const routes = (env: Env) => {
  envOf = env
  return (handle ??= sessionLogRoutes({
    store: d1SessionLogStore(env.DB),
    // A dashboard viewer, else an admin-console visitor.
    identify: async req => {
      const { viewGate, adminGate } = gates(envOf!, req)
      return (await fromGate(viewGate).identify(req)) ?? (await fromGate(adminGate).identify(req))
    },
    requireAdmin: req => fromGate(gates(envOf!, req).adminGate, { adminScope: REQUESTS_SCOPE }).requireAdmin(req),
    appEvents: { 'demo.mint': ['scopes', 'expires'] },
  }))
}

export const onRequest = async ({ request, env, waitUntil }: Ctx): Promise<Response> =>
  (await routes(env)(request, { waitUntil })) ?? new Response('not found\n', { status: 404 })
