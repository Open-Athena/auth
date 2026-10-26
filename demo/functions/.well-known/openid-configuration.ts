/** The broker's discovery document; see `_lib/broker.ts`. */
import { type BrokerEnv, broker } from '../_lib/broker.js'

export const onRequest = async ({ request, env }: { request: Request; env: BrokerEnv }): Promise<Response> =>
  (await (await broker(env, request)).provider(request)) ?? new Response('not found\n', { status: 404 })
