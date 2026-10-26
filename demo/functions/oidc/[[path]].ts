/** The demo's OIDC endpoints (`/oidc/authorize`, `/token`, `/jwks`, `/userinfo`, `/logout`); see `_lib/broker.ts`. */
import { type BrokerEnv, broker } from '../_lib/broker.js'

export const onRequest = async ({ request, env }: { request: Request; env: BrokerEnv }): Promise<Response> =>
  (await (await broker(env, request)).provider(request)) ?? new Response('not found\n', { status: 404 })
