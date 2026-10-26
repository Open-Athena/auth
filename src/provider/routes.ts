/**
 * A small OpenID Connect provider over a gate: the gate's sign-in (Google,
 * emailed codes) and sessions are the provider's, and this turns "this browser
 * is signed in here as X" into an ID token for one of a fixed list of apps.
 *
 * Deliberately narrow (see `specs/oidc-provider.md`): authorization code with
 * PKCE S256 only, confidential clients from a static registry, exact redirect
 * URIs, no consent screen (every client is first-party), no refresh tokens.
 * What it leaves out it refuses, rather than half-supporting.
 */
import { b64uEncode } from '../core/base64.js'
import type { Gate } from '../core/gate.js'
import { generateToken, hashToken } from '../core/tokens.js'
import { type KeySet, keySet, type SigningJwk } from './keys.js'
import type { ProviderStore } from './store.js'

/** One app allowed to sign people in here. */
export interface ProviderClient {
  id: string
  /** `hashClientSecret(secret)`: the secret itself never sits in config. */
  secretHash: string
  /** Exact matches only: no prefixes, no wildcards, no normalizing. */
  redirectUris: string[]
  /** Where RP-initiated logout may send the browser afterwards (exact matches). */
  postLogoutRedirectUris?: string[]
  /** A per-app admission rule on top of the provider's `policy`. */
  allow?: (email: string) => boolean | Promise<boolean>
}

export interface ClaimsInput {
  email: string
  client: ProviderClient
  /** The granted scopes. */
  scopes: string[]
}

export interface ProviderOptions {
  /** The broker's gate: its sessions are who is signed in here. */
  gate: Gate
  /** Exactly what tokens carry as `iss`, e.g. `https://login.oa.dev`. No trailing slash. */
  issuer: string
  clients: ProviderClient[]
  /** Private RS256 JWKs; the first signs, all are published. */
  keys: SigningJwk[]
  store: ProviderStore
  /**
   * Keys `sub`: `HMAC(subjectSecret, "e:" + email)`. Stable across clients and
   * deployments, so keep it stable too: changing it changes every `sub`.
   */
  subjectSecret: string
  /** Where the endpoints live under the issuer's origin (default `/oidc`). */
  basePath?: string
  /**
   * The broker's sign-in page (same origin). Sent `next` (back to
   * `/authorize`), and `prompt` / `login_hint` when the app gave them. It must
   * return to `next` only once someone is signed in.
   */
  loginUrl: string
  /** Who may sign in to any app here at all (default: anyone the gate admits). */
  policy?: (input: { email: string; client: ProviderClient }) => boolean | Promise<boolean>
  /** Extra ID token and userinfo claims (`groups`, say). Can't override the standard ones. */
  claims?: (input: ClaimsInput) => Record<string, unknown> | Promise<Record<string, unknown>>
  /** Extra scopes advertised in discovery, for `claims` to act on. */
  scopes?: string[]
  /** ID and access token lifetime (default 300 s). */
  tokenTtlS?: number
  /** Authorization code lifetime (default 60 s). */
  codeTtlS?: number
}

/** What a client registry stores in place of a secret. */
export const hashClientSecret = (secret: string): Promise<string> => hashToken(secret)

const STANDARD_SCOPES = ['openid', 'email', 'profile']
/** Claims a `claims` hook may not set: they're the provider's to vouch for. */
const RESERVED = new Set(['iss', 'sub', 'aud', 'exp', 'iat', 'auth_time', 'nonce', 'azp', 'email', 'email_verified', 'name', 'picture', 'scope', 'client_id'])
/** RFC 7636: 43–128 unreserved characters. */
const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/
const CHALLENGE = /^[A-Za-z0-9\-_]{43}$/
/** The marker `/authorize` adds when it sends someone to sign in afresh. */
const LOGIN_AFTER = 'oa_login_after'

const enc = new TextEncoder()
const sec = (ms: number) => Math.floor(ms / 1000)

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body) + '\n', {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', pragma: 'no-cache', ...headers },
  })

/** An error the browser sees here, because there's no trustworthy place to send it. */
const page = (status: number, message: string): Response =>
  new Response(`${message}\n`, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } })

const redirect = (location: string, cookies: string[] = []): Response => {
  const headers = new Headers({ location, 'cache-control': 'no-store' })
  for (const c of cookies) headers.append('set-cookie', c)
  return new Response(null, { status: 302, headers })
}

async function hmac(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return b64uEncode(await crypto.subtle.sign('HMAC', key, enc.encode(value)))
}

const s256 = async (verifier: string): Promise<string> => b64uEncode(await crypto.subtle.digest('SHA-256', enc.encode(verifier)))

/** Equal-length strings compared without an early exit. */
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return d === 0
}

export function oidcProviderRoutes(opts: ProviderOptions) {
  const { gate, store, subjectSecret, loginUrl, policy, tokenTtlS = 300, codeTtlS = 60 } = opts
  const issuer = opts.issuer.replace(/\/+$/, '')
  const origin = new URL(issuer).origin
  const base = (opts.basePath ?? '/oidc').replace(/\/+$/, '')
  const discoveryPath = `${new URL(issuer).pathname.replace(/\/+$/, '')}/.well-known/openid-configuration`
  const endpoint = (p: string) => `${origin}${base}${p}`
  const userinfoAud = endpoint('/userinfo')
  const clients = new Map(opts.clients.map(c => [c.id, c]))
  if (clients.size !== opts.clients.length) throw new Error('duplicate client id')
  let keys: KeySet | null = null
  const ks = () => (keys ??= keySet(opts.keys))
  const scopesSupported = [...STANDARD_SCOPES, ...(opts.scopes ?? [])]

  const discovery = () => ({
    issuer,
    authorization_endpoint: endpoint('/authorize'),
    token_endpoint: endpoint('/token'),
    userinfo_endpoint: userinfoAud,
    jwks_uri: endpoint('/jwks'),
    end_session_endpoint: endpoint('/logout'),
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: scopesSupported,
    claims_supported: ['iss', 'sub', 'aud', 'exp', 'iat', 'auth_time', 'nonce', 'email', 'email_verified', 'name', 'picture'],
    prompt_values_supported: ['none', 'login', 'select_account'],
    authorization_response_iss_parameter_supported: true,
    request_parameter_supported: false,
    request_uri_parameter_supported: false,
    claims_parameter_supported: false,
  })

  const subOf = (email: string) => hmac(subjectSecret, `e:${email}`)

  /** The standard claims for this person and scope set, plus the app's extras. */
  async function claimsFor(email: string, client: ProviderClient, scopes: string[]): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {}
    if (opts.claims) {
      for (const [k, v] of Object.entries(await opts.claims({ email, client, scopes }))) if (!RESERVED.has(k)) out[k] = v
    }
    if (scopes.includes('email')) Object.assign(out, { email, email_verified: true })
    if (scopes.includes('profile')) {
      const subject = await gate.subjectFor(email)
      if (subject?.name) out.name = subject.name
      // Only a fetchable URL: an inline `data:` face would bloat every token.
      if (subject?.avatar && /^https:\/\//.test(subject.avatar)) out.picture = subject.avatar
    }
    return out
  }

  async function admitted(email: string, client: ProviderClient): Promise<boolean> {
    if (policy && !(await policy({ email, client }))) return false
    if (client.allow && !(await client.allow(email))) return false
    return true
  }

  // ---- /authorize ----------------------------------------------------------

  async function authorize(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const q = url.searchParams
    // Repeated parameters are ambiguous, and ambiguity is how parsers get split.
    for (const k of new Set(q.keys())) if (q.getAll(k).length > 1) return page(400, `repeated parameter: ${k}`)

    const client = clients.get(q.get('client_id') ?? '')
    if (!client) return page(400, 'unknown client')
    const redirectUri = q.get('redirect_uri')
    // Exact, before anything is redirected: an unregistered URI must never
    // receive anything, an error included, or this is an open redirect.
    if (!redirectUri || !client.redirectUris.includes(redirectUri)) return page(400, 'redirect_uri is not registered for this client')

    const state = q.get('state')
    const back = (params: Record<string, string>): Response => {
      const to = new URL(redirectUri)
      for (const [k, v] of Object.entries({ ...params, ...(state !== null ? { state } : {}), iss: issuer })) to.searchParams.set(k, v)
      return redirect(to.toString())
    }
    const fail = (error: string, description?: string) => back({ error, ...(description ? { error_description: description } : {}) })

    if (q.has('request') || q.has('request_uri')) return fail(q.has('request') ? 'request_not_supported' : 'request_uri_not_supported')
    if (q.get('response_type') !== 'code') return fail('unsupported_response_type')
    const scopes = (q.get('scope') ?? '').split(' ').filter(Boolean)
    if (!scopes.includes('openid')) return fail('invalid_scope', 'openid is required')
    const granted = scopes.filter(s => scopesSupported.includes(s))
    const challenge = q.get('code_challenge')
    if (!challenge || q.get('code_challenge_method') !== 'S256' || !CHALLENGE.test(challenge)) {
      return fail('invalid_request', 'PKCE with code_challenge_method=S256 is required')
    }
    const prompts = new Set((q.get('prompt') ?? '').split(' ').filter(Boolean))
    if (prompts.has('none') && prompts.size > 1) return fail('invalid_request', 'prompt=none must be alone')
    const maxAge = q.has('max_age') ? Number(q.get('max_age')) : null
    if (maxAge !== null && !(Number.isInteger(maxAge) && maxAge >= 0)) return fail('invalid_request', 'bad max_age')

    const nowMs = Date.now()
    const nowS = sec(nowMs)
    const result = await gate.authenticateResult(req, nowMs, { logView: false })
    // Only a verified person at the broker vouches for anyone: a share-link
    // session here is a guest, and an app must never take it for an account.
    const email = result.auth?.kind === 'sso' ? result.auth.email : null
    const authTime = email && result.issuedAt ? result.issuedAt : null
    // A sign-in this flow sent someone to must have happened after it did.
    const after = Number(q.get(LOGIN_AFTER) ?? NaN)
    const freshEnough =
      (!Number.isFinite(after) || (authTime !== null && authTime >= Math.min(after, nowS))) &&
      (maxAge === null || (authTime !== null && nowS - authTime <= maxAge))
    const wantLogin = prompts.has('login') && !Number.isFinite(after)
    const wantChooser = prompts.has('select_account')

    if (!email || !freshEnough || wantLogin || wantChooser) {
      // No one selected (or a guest), but the browser holds verified accounts
      // here: a choice is what's missing, not a sign-in.
      const choosable =
        !email && gate.retained
          ? ((await gate.retained.accounts(req, nowMs))?.accounts ?? []).some(a => a.kind === 'sso')
          : false
      if (prompts.has('none')) return fail(choosable ? 'account_selection_required' : 'login_required')
      // Back here afterwards, without the prompt that sent them (or this loops),
      // and with the time it sent them, so an older session can't satisfy it.
      const next = new URL(url)
      next.searchParams.delete('prompt')
      if (wantLogin || (email && !freshEnough)) next.searchParams.set(LOGIN_AFTER, String(nowS))
      const to = new URL(loginUrl, origin)
      to.searchParams.set('next', `${next.pathname}${next.search}`)
      if (wantChooser || (choosable && !wantLogin)) to.searchParams.set('prompt', 'select_account')
      else if (wantLogin || email) to.searchParams.set('prompt', 'login')
      const hint = q.get('login_hint')
      if (hint) to.searchParams.set('login_hint', hint)
      return redirect(to.toString())
    }

    if (!(await admitted(email, client))) return fail('access_denied')

    const code = generateToken()
    await store.putCode({
      codeHash: await hashToken(code),
      clientId: client.id,
      redirectUri,
      challenge,
      nonce: q.get('nonce'),
      email,
      scope: granted.join(' '),
      authTime,
      expiresAt: nowS + codeTtlS,
    })
    return back({ code })
  }

  // ---- /token --------------------------------------------------------------

  /** The authenticated client, or the error response. */
  async function clientAuth(req: Request, form: URLSearchParams): Promise<ProviderClient | Response> {
    const basic = req.headers.get('authorization')?.match(/^Basic\s+(.+)$/i)
    const invalid = (status = 401) =>
      json({ error: 'invalid_client' }, status, basic ? { 'www-authenticate': 'Basic realm="token"' } : {})
    let id: string | null
    let secret: string | null
    if (basic) {
      if (form.has('client_secret')) return json({ error: 'invalid_request', error_description: 'one client authentication method' }, 400)
      let decoded: string
      try {
        decoded = atob(basic[1]!)
      } catch {
        return invalid()
      }
      const i = decoded.indexOf(':')
      if (i < 0) return invalid()
      // RFC 6749 §2.3.1: both halves are form-urlencoded inside the header.
      try {
        id = decodeURIComponent(decoded.slice(0, i).replace(/\+/g, ' '))
        secret = decodeURIComponent(decoded.slice(i + 1).replace(/\+/g, ' '))
      } catch {
        return invalid()
      }
      if (form.has('client_id') && form.get('client_id') !== id) return invalid()
    } else {
      id = form.get('client_id')
      secret = form.get('client_secret')
    }
    const client = clients.get(id ?? '')
    if (!client || !secret) return invalid()
    if (!same(await hashClientSecret(secret), client.secretHash)) return invalid()
    return client
  }

  async function token(req: Request): Promise<Response> {
    if (req.method !== 'POST') return json({ error: 'invalid_request' }, 405, { allow: 'POST' })
    if (!(req.headers.get('content-type') ?? '').startsWith('application/x-www-form-urlencoded')) {
      return json({ error: 'invalid_request', error_description: 'form-encoded body required' }, 400)
    }
    const form = new URLSearchParams(await req.text())
    for (const k of new Set(form.keys())) if (form.getAll(k).length > 1) return json({ error: 'invalid_request' }, 400)
    const client = await clientAuth(req, form)
    if (client instanceof Response) return client
    if (form.get('grant_type') !== 'authorization_code') return json({ error: 'unsupported_grant_type' }, 400)

    const code = form.get('code')
    const verifier = form.get('code_verifier')
    if (!code || !verifier) return json({ error: 'invalid_request' }, 400)
    const nowS = sec(Date.now())
    // Taken before any check: a code is spent by any attempt to use it, so a
    // stolen one is worth at most one guess.
    const rec = await store.takeCode(await hashToken(code), nowS)
    if (
      !rec ||
      rec.clientId !== client.id ||
      rec.redirectUri !== form.get('redirect_uri') ||
      !VERIFIER.test(verifier) ||
      !same(await s256(verifier), rec.challenge)
    ) {
      return json({ error: 'invalid_grant' }, 400)
    }
    // Re-checked at exchange: someone delisted in the last minute is refused.
    if (!(await admitted(rec.email, client))) return json({ error: 'invalid_grant' }, 400)
    if (Math.random() < 0.05) await store.cleanup(nowS).catch(() => 0)

    const scopes = rec.scope.split(' ').filter(Boolean)
    const sub = await subOf(rec.email)
    const extra = await claimsFor(rec.email, client, scopes)
    const idToken = await ks().sign({
      ...extra,
      iss: issuer,
      sub,
      aud: client.id,
      iat: nowS,
      exp: nowS + tokenTtlS,
      ...(rec.authTime !== null ? { auth_time: rec.authTime } : {}),
      ...(rec.nonce !== null ? { nonce: rec.nonce } : {}),
    })
    const accessToken = await ks().sign(
      { iss: issuer, sub, aud: userinfoAud, client_id: client.id, scope: rec.scope, email: rec.email, iat: nowS, exp: nowS + tokenTtlS },
      'at+jwt',
    )
    return json({ access_token: accessToken, token_type: 'Bearer', expires_in: tokenTtlS, id_token: idToken, scope: rec.scope })
  }

  // ---- /userinfo -----------------------------------------------------------

  async function userinfo(req: Request): Promise<Response> {
    const bearer = req.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]
    const challenge = (error: string) => json({ error }, 401, { 'www-authenticate': `Bearer error="${error}"` })
    if (!bearer) return json({ error: 'invalid_request' }, 401, { 'www-authenticate': 'Bearer' })
    const at = await ks().verify<{ iss?: unknown; aud?: unknown; exp?: unknown; sub?: unknown; email?: unknown; scope?: unknown; client_id?: unknown }>(bearer)
    const nowS = sec(Date.now())
    if (
      !at ||
      at.iss !== issuer ||
      at.aud !== userinfoAud ||
      typeof at.exp !== 'number' ||
      at.exp <= nowS ||
      typeof at.sub !== 'string' ||
      typeof at.email !== 'string' ||
      typeof at.scope !== 'string'
    ) {
      return challenge('invalid_token')
    }
    const client = clients.get(String(at.client_id))
    if (!client || !(await admitted(at.email, client))) return challenge('invalid_token')
    return json({ ...(await claimsFor(at.email, client, at.scope.split(' '))), sub: at.sub })
  }

  // ---- /logout -------------------------------------------------------------

  async function logout(req: Request): Promise<Response> {
    const params =
      req.method === 'POST' && (req.headers.get('content-type') ?? '').startsWith('application/x-www-form-urlencoded')
        ? new URLSearchParams(await req.text())
        : new URL(req.url).searchParams
    const hint = params.get('id_token_hint')
    // An expired hint is still evidence of which app is asking (OIDC
    // RP-Initiated Logout §2): only the signature and issuer are checked.
    const claims = hint ? await ks().verify<{ iss?: unknown; aud?: unknown }>(hint) : null
    const client = claims && claims.iss === issuer ? clients.get(String(claims.aud)) : undefined
    const postLogout = params.get('post_logout_redirect_uri')
    const cookies = await gate.signOutCookies(req)

    if (client && postLogout && (client.postLogoutRedirectUris ?? []).includes(postLogout)) {
      const to = new URL(postLogout)
      const state = params.get('state')
      if (state !== null) to.searchParams.set('state', state)
      return redirect(to.toString(), cookies)
    }
    const headers = new Headers({ 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    for (const c of cookies) headers.append('set-cookie', c)
    return new Response('Signed out.\n', { status: 200, headers })
  }

  return async (req: Request): Promise<Response | null> => {
    const path = new URL(req.url).pathname
    if (path === discoveryPath && req.method === 'GET') return json(discovery(), 200, { 'cache-control': 'public, max-age=300' })
    if (!path.startsWith(`${base}/`)) return null
    switch (path.slice(base.length)) {
      case '/jwks':
        return json(ks().jwks, 200, { 'cache-control': 'public, max-age=300' })
      case '/authorize':
        return req.method === 'GET' ? authorize(req) : page(405, 'GET only')
      case '/token':
        return token(req)
      case '/userinfo':
        return req.method === 'GET' || req.method === 'POST' ? userinfo(req) : json({ error: 'invalid_request' }, 405)
      case '/logout':
        return logout(req)
      default:
        return null
    }
  }
}

/** For an app: the broker as an `OidcProvider` (`@open-athena/auth/oidc`), from its issuer. */
export function brokerProvider(issuer: string, { basePath = '/oidc', scope = 'openid email profile' } = {}) {
  const iss = issuer.replace(/\/+$/, '')
  const origin = new URL(iss).origin
  return {
    authUrl: `${origin}${basePath}/authorize`,
    tokenUrl: `${origin}${basePath}/token`,
    jwksUrl: `${origin}${basePath}/jwks`,
    issuer: iss,
    scope,
  }
}

