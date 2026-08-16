/**
 * The recipient-side API: whoami, `?key=` exchange, logout, request-access.
 * Public — this is what the wall talks to.
 */
import { authRoutes } from '@open-athena/auth'
import { type Env, VIEW_SCOPE, gates } from '../../_lib/gates.js'

interface Ctx {
  request: Request
  env: Env
}

export const onRequest = async ({ request, env }: Ctx): Promise<Response> => {
  const { viewGate } = gates(env, request)
  const handle = authRoutes(viewGate, {
    basePath: '/api/view',
    // Nobody holds this scope, so the admin routes on this mount are inert:
    // the console lives on `/api/admin` under its own cookie.
    adminScope: 'view-admin-unused',
  })
  return (await handle(request)) ?? new Response('not found\n', { status: 404 })
}
