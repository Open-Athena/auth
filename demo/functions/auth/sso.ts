/**
 * The only Access-gated path on the site. Everything else — including the
 * landing page and its og:image — stays public at the edge, so unfurls and
 * crawlers work; CF Access is reduced to an SSO IdP on this one route.
 *
 * Written out rather than using the packaged `ssoHandler` because the demo
 * signs into *both* gates at once (staff are both viewers and admins), which is
 * a fair illustration that the adapter pieces compose.
 */
import { verifyAccessJwt } from '@open-athena/auth/cf-access'
import { type Env, gates } from '../_lib/gates.js'

interface Ctx {
  request: Request
  env: Env
}

/** Reject absolute and protocol-relative targets — an open redirect off a login path. */
const safeNext = (raw: string | null): string => (raw && raw.startsWith('/') && !raw.startsWith('//') ? raw : '/')

export const onRequest = async ({ request, env }: Ctx): Promise<Response> => {
  const teamDomain = env.ACCESS_TEAM_DOMAIN
  if (!teamDomain) return new Response('ACCESS_TEAM_DOMAIN not configured\n', { status: 503 })

  const jwt = request.headers.get('Cf-Access-Jwt-Assertion')
  if (!jwt) return new Response('no Access JWT — is this path still gated?\n', { status: 401 })
  const email = await verifyAccessJwt(jwt, teamDomain, env.ACCESS_AUD)
  if (!email) return new Response('Access JWT failed verification\n', { status: 401 })

  const { viewGate, adminGate } = gates(env, request)
  const [view, admin] = await Promise.all([viewGate.signIn(email, request), adminGate.signIn(email, request)])
  if (!view && !admin) return new Response(`${email} is not authorized for this app\n`, { status: 403 })

  const headers = new Headers({ location: safeNext(new URL(request.url).searchParams.get('next')) })
  for (const c of [view?.cookie, admin?.cookie]) if (c) headers.append('set-cookie', c)
  return new Response(null, { status: 302, headers })
}
