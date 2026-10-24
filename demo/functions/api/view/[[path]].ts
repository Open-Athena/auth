/**
 * The recipient-side API: whoami, `?key=` exchange, logout, request-access.
 * Public — this is what the wall talks to.
 */
import { authRoutes } from '@open-athena/auth'
import { type Env, VIEW_SCOPE, gates } from '../../_lib/gates.js'

interface Ctx {
  request: Request
  env: Env
  waitUntil: (p: Promise<unknown>) => void
}

export const onRequest = async ({ request, env, waitUntil }: Ctx): Promise<Response> => {
  const { viewGate, retainedStore } = gates(env, request)
  // Pages Functions have no cron, so retained-login maintenance rides a small
  // share of requests: bounded, idempotent, and never on the response path.
  if (Math.random() < 0.02) waitUntil(retainedStore.cleanup(Math.floor(Date.now() / 1000)).catch(() => 0))
  const handle = authRoutes(viewGate, {
    basePath: '/api/view',
    // Nobody holds this scope, so the admin routes on this mount are inert:
    // the console lives on `/api/admin` under its own cookie.
    adminScope: 'view-admin-unused',
  })
  return (await handle(request)) ?? new Response('not found\n', { status: 404 })
}
