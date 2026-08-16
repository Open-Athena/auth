/**
 * The console API. Every read and write is confined to grants this identity
 * created (`scopeToCreator`), which is what lets strangers share one deployment
 * without seeing — or revoking — each other's links. Someone else's grant id
 * 404s rather than 403s, so ids stay unconfirmed.
 */
import { authRoutes } from '@open-athena/auth'
import { ADMIN_SCOPE, type Env, REQUESTS_SCOPE, gates } from '../../_lib/gates.js'

interface Ctx {
  request: Request
  env: Env
}

export const onRequest = async ({ request, env }: Ctx): Promise<Response> => {
  const { adminGate, auditQuery } = gates(env, request)
  const handle = authRoutes(adminGate, {
    basePath: '/api/admin',
    adminScope: ADMIN_SCOPE,
    requestScope: REQUESTS_SCOPE,
    audit: auditQuery,
    creatorOf: auth => (auth.kind === 'sso' ? auth.email : `g:${auth.grant.id}`),
    scopeToCreator: auth => (auth.kind === 'sso' ? auth.email : undefined),
  })
  return (await handle(request)) ?? new Response('not found\n', { status: 404 })
}
