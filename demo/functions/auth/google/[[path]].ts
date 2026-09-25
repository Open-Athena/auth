/**
 * Sign in with Google directly — no Cloudflare Access in the loop, no Zero
 * Trust seat per user. Two shapes of the same identity:
 *
 *   GET  /auth/google/start         -> redirect flow (`oidcStart`)
 *   GET  /auth/google/callback      -> `oidcCallback`: verify the id_token, sign in, 302 to `next`
 *   GET  /auth/google/onetap/nonce  -> `googleOneTapNonce`, for the in-page button
 *   POST /auth/google/onetap        -> `googleOneTapVerify`: same verification, session in this response
 *   GET  /auth/google/client        -> demo only: the public client id, so the page knows whether to render One Tap
 *
 * Both land in `viewGate.signIn`, like an emailed code; staff then promote to
 * the admin gate via `/api/staff`. Dormant
 * (503) until a client exists: Google exposes no API to create one, so
 * `scripts/provision-oauth-client.mjs` walks the one manual step and stores
 * `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` as Pages secrets.
 */
import { googleOneTapNonce, googleOneTapVerify, oidcCallback, oidcStart } from '@open-athena/auth/oidc'
import { type Env, gates, json } from '../../_lib/gates.js'

interface Ctx {
  request: Request
  env: Env
}

export const onRequest = async ({ request, env }: Ctx): Promise<Response> => {
  const url = new URL(request.url)
  const route = url.pathname.slice('/auth/google/'.length)
  const clientId = env.GOOGLE_CLIENT_ID ?? null

  // Public by design — the client id ships in every page that renders One Tap.
  if (route === 'client' && request.method === 'GET') return json({ clientId })

  if (!clientId || !env.GOOGLE_CLIENT_SECRET) {
    return new Response(
      'Google sign-in is not configured here: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET ' +
        '(scripts/provision-oauth-client.mjs prints the form and stores them).\n',
      { status: 503 },
    )
  }

  const { viewGate } = gates(env, request)
  const cfg = {
    gate: viewGate,
    clientId,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: `${url.origin}/auth/google/callback`,
    // A first Google sign-in gets the name and face Google vouched for, so the
    // chip says "Ada Lovelace" rather than initials.
    seedProfile: true,
  }

  switch (route) {
    case 'start':
      return oidcStart(cfg)({ request })
    case 'callback':
      return oidcCallback(cfg)({ request })
    case 'onetap/nonce':
      return googleOneTapNonce({ gate: viewGate })()
    case 'onetap':
      return googleOneTapVerify({ gate: viewGate, clientId, seedProfile: true })({ request })
    default:
      return new Response('not found\n', { status: 404 })
  }
}
