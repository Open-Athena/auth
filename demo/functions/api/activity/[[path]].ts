import { activityRoutes } from '@open-athena/auth/activity'
import { fromGate } from '@open-athena/auth/session-log'
import { demoActivity } from '../../_lib/activity.js'
import { gates, REQUESTS_SCOPE, type Env } from '../../_lib/gates.js'

export const onRequest = async ({ request, env }: { request: Request; env: Env }): Promise<Response> => {
  const { feed, store } = demoActivity(env)
  const handle = activityRoutes({ feed, store, requireAdmin: req => fromGate(gates(env, req).adminGate, { adminScope: REQUESTS_SCOPE }).requireAdmin(req) })
  try { return (await handle(request)) ?? new Response(null, { status: 404 }) } catch (error) {
    if (/no such table: activity_/.test(String(error))) {
      return Response.json({ error: 'Activity storage is not configured on this deployment' }, { status: 503, headers: { 'cache-control': 'no-store' } })
    }
    throw error
  }
}
