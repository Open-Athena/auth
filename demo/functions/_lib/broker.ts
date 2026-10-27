/**
 * The demo as an OIDC broker (`@open-athena/auth/provider`) and, at `/rp`, a
 * second "app" that signs in through it: the same origin, but its own gate and
 * cookie, so it knows nothing about the dashboard's session except what the
 * broker's ID token tells it.
 *
 * The broker's people are the dashboard's (`viewGate`): sign in there by
 * emailed code or Google, and `/rp` gets you with no page in between.
 *
 * The issuer is the request's origin, so the same code serves localhost, a
 * tailnet name and auth.oa.dev. The signing key is `OIDC_SIGNING_KEY` (a
 * private JWK from `generateSigningKey`), or, on localhost only, one generated
 * per isolate: fine for a dev server, wrong anywhere tokens must outlive it.
 */
import { createGate } from '@open-athena/auth'
import { d1GrantStore } from '@open-athena/auth/d1'
import { brokerProvider, generateSigningKey, hashClientSecret, oidcProviderRoutes, type SigningJwk } from '@open-athena/auth/provider'
import { d1ProviderStore } from '@open-athena/auth/provider/d1'
import { type Env, gates } from './gates.js'

export interface BrokerEnv extends Env {
  /** A private RS256 JWK (JSON). Required off localhost. */
  OIDC_SIGNING_KEY?: string
  /**
   * Set only while running the OpenID Foundation's hosted conformance suite
   * (www.certification.openid.net) against this broker: the secret of its two
   * test clients, which may skip PKCE as that suite's Basic OP plan does.
   */
  OIDC_CONFORMANCE_SECRET?: string
}

export const RP_CLIENT_ID = 'demo-rp'
export const RP_COOKIE = 'oa_demo_rp'
/** The test-plan alias on the hosted suite, which fixes its callback URL. */
export const CONFORMANCE_ALIAS = 'oa-auth-demo'
export const CONFORMANCE_CLIENT_IDS = ['oidf-conformance', 'oidf-conformance-2']

let devKey: Promise<SigningJwk> | null = null

async function signingKey(env: BrokerEnv, req: Request): Promise<SigningJwk> {
  if (env.OIDC_SIGNING_KEY) return JSON.parse(env.OIDC_SIGNING_KEY) as SigningJwk
  const { hostname } = new URL(req.url)
  if (hostname === 'auth.oa.dev' || hostname.endsWith('.pages.dev')) throw new Error('OIDC_SIGNING_KEY is not configured')
  return (devKey ??= generateSigningKey('dev'))
}

/** The demo RP's client secret: derived from the session secret, so there's nothing extra to configure. */
async function rpSecret(secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('demo-rp-client')))
  return btoa(String.fromCharCode(...mac)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function broker(env: BrokerEnv, req: Request) {
  const origin = new URL(req.url).origin
  const { viewGate, secret } = gates(env, req)
  const clientSecret = await rpSecret(secret)
  const provider = oidcProviderRoutes({
    gate: viewGate,
    issuer: origin,
    clients: [
      {
        id: RP_CLIENT_ID,
        secretHash: await hashClientSecret(clientSecret),
        redirectUris: [`${origin}/rp/callback`],
        postLogoutRedirectUris: [`${origin}/rp`],
      },
      ...(env.OIDC_CONFORMANCE_SECRET
        ? await Promise.all(
            CONFORMANCE_CLIENT_IDS.map(async id => ({
              id,
              secretHash: await hashClientSecret(env.OIDC_CONFORMANCE_SECRET!),
              redirectUris: [`https://www.certification.openid.net/test/a/${CONFORMANCE_ALIAS}/callback`],
              requirePkce: false,
            })),
          )
        : []),
    ],
    keys: [await signingKey(env, req)],
    store: d1ProviderStore(env.DB),
    subjectSecret: secret,
    loginUrl: '/signin',
  })

  const rpGate = createGate({ store: d1GrantStore(env.DB), secret, cookieName: RP_COOKIE, policy: async () => ['view'] })
  // The RP's server-to-server calls (token, JWKS) to the broker stay in this
  // isolate: same origin, so there's no network hop to make.
  const rpFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const r = new Request(input, init)
    return new URL(r.url).origin === origin ? ((await provider(r)) ?? new Response('not found', { status: 404 })) : fetch(r)
  }) as typeof fetch
  const rp = {
    gate: rpGate,
    clientId: RP_CLIENT_ID,
    clientSecret,
    redirectUri: `${origin}/rp/callback`,
    provider: brokerProvider(origin),
    accountHintCookie: false as const,
    nonceCookieName: 'oa_demo_rp_nonce',
    fetch: rpFetch,
  }
  return { provider, rpGate, rp }
}
