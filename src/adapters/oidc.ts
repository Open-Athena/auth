/**
 * Sign in with an OIDC provider directly, instead of putting Cloudflare Access
 * in front of the app as an IdP.
 *
 * Requested by marin-gcs-usage (`specs/google-oidc-idp.md`) for two reasons
 * worth recording: Access's hosted chooser is generic and unstylable, and —
 * the harder constraint — every Access-authenticated user consumes a Zero
 * Trust seat, which is a ceiling a growing allowlist eventually hits. Share
 * links never touched Access, which is why they never had that problem.
 *
 * Generic rather than Google-only: an issuer is four URLs, and `GOOGLE` is a
 * preset rather than a special case. Only the authorization-code flow, only
 * confidential clients (server-side, with a secret) — that's what a Worker or
 * Pages Function is.
 *
 * The two things that make this safe are both storage-free:
 *
 * - **state** is HMAC'd with the gate secret and carries the `next` path plus a
 *   nonce, so nothing has to be persisted between the two requests;
 * - **the nonce is double-submitted** — it rides in the signed state *and* in a
 *   short-lived cookie, and both must agree. Without that, a signed state an
 *   attacker minted from their own sign-in would be replayable against someone
 *   else's browser, which is login-CSRF: the victim ends up silently signed in
 *   as the attacker.
 */
import { b64uEncode } from '../core/base64.js'
import type { Gate } from '../core/gate.js'
import { verifyRs256Jwt } from '../core/jwt.js'
import { clearCookie, isSecureRequest, sessionCookie, signSession, verifySession } from '../core/session.js'
import { generateToken } from '../core/tokens.js'

export interface OidcProvider {
  authUrl: string
  tokenUrl: string
  jwksUrl: string
  /** Accepted `iss` values. Google notoriously issues two spellings. */
  issuer: string | string[]
  scope: string
}

export const GOOGLE: OidcProvider = {
  authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs',
  // Both are legitimate and which one you get has varied over time; rejecting
  // the bare form is a spurious sign-in failure nobody can debug from the logs.
  issuer: ['https://accounts.google.com', 'accounts.google.com'],
  scope: 'openid email profile',
}

export interface OidcOptions {
  gate: Gate
  clientId: string
  clientSecret: string
  /** Must match the provider's registered redirect exactly. */
  redirectUri: string
  provider?: OidcProvider
  /** Extra authorization params — `hd` to hint a Google Workspace domain, say. */
  authParams?: Record<string, string>
  /** How long the sign-in round-trip may take. Default 10 minutes. */
  stateTtlS?: number
  /** Cookie holding the nonce between the two requests. */
  nonceCookieName?: string
  fetch?: typeof globalThis.fetch
}

const DEFAULT_NONCE_COOKIE = 'oa_oidc'
const STATE_PREFIX = 'oidc:'

interface IdTokenClaims extends Record<string, unknown> {
  email?: string
  email_verified?: boolean
  nonce?: string
}

/** Only same-origin paths, so `?next=` can't become an open redirect. */
const safeNext = (raw: string | null): string => (raw && raw.startsWith('/') && !raw.startsWith('//') ? raw : '/')

/**
 * Start the flow: mint a nonce, sign it into the state, and bounce to the
 * provider.
 *
 * The state is signed with the *session* secret but can never be presented as
 * a session: `parseSub` only accepts `e:`/`g:` subjects, and this one is
 * `oidc:`. The reverse holds too — a stolen session cookie is not a valid
 * state — so the two token types are mutually inert.
 */
export function oidcStart(opts: OidcOptions) {
  const { gate, clientId, redirectUri, provider = GOOGLE, authParams = {}, stateTtlS = 600 } = opts
  const nonceCookie = opts.nonceCookieName ?? DEFAULT_NONCE_COOKIE

  return async ({ request }: { request: Request }): Promise<Response> => {
    const nonce = generateToken()
    const next = safeNext(new URL(request.url).searchParams.get('next'))
    const state = await signSession(`${STATE_PREFIX}${nonce}:${next}`, gate.secret, Date.now(), stateTtlS)

    const url = new URL(provider.authUrl)
    url.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: provider.scope,
      state,
      nonce,
      ...authParams,
    }).toString()

    return new Response(null, {
      status: 302,
      headers: {
        location: url.toString(),
        // `SameSite=Lax` still arrives on the provider's top-level redirect
        // back, which is the only place it needs to be readable.
        'set-cookie': sessionCookie(nonce, {
          name: nonceCookie,
          secure: isSecureRequest(request),
          ttlS: stateTtlS,
        }),
        'cache-control': 'no-store',
      },
    })
  }
}

/**
 * Finish the flow: check the state and nonce, trade the code for an id_token,
 * verify it, and mint a session for the address it names.
 *
 * Every failure is a plain 400/401 with no detail, because everything here is
 * attacker-reachable and the differences between "bad state" and "bad nonce"
 * are only useful to whoever is probing.
 */
export function oidcCallback(opts: OidcOptions) {
  const { gate, clientId, clientSecret, redirectUri, provider = GOOGLE } = opts
  const nonceCookie = opts.nonceCookieName ?? DEFAULT_NONCE_COOKIE
  const doFetch = opts.fetch ?? globalThis.fetch

  return async ({ request }: { request: Request }): Promise<Response> => {
    const url = new URL(request.url)
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    if (!code || !state) return deny('missing code or state')

    const sub = await verifySession(state, gate.secret, Date.now())
    if (!sub?.startsWith(STATE_PREFIX)) return deny('bad state')
    const rest = sub.slice(STATE_PREFIX.length)
    const sep = rest.indexOf(':')
    if (sep < 0) return deny('bad state')
    const nonce = rest.slice(0, sep)
    const next = safeNext(rest.slice(sep + 1))

    // The double-submit. A valid signature proves *we* minted this state; the
    // cookie proves it was minted for *this browser*.
    const cookieNonce = readCookieValue(request, nonceCookie)
    if (!cookieNonce || cookieNonce !== nonce) return deny('state was not issued to this browser')

    const token = await doFetch(provider.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }).toString(),
    })
      .then(r => (r.ok ? (r.json() as Promise<{ id_token?: string }>) : null))
      .catch(() => null)
    if (!token?.id_token) return deny('token exchange failed')

    const claims = await verifyRs256Jwt<IdTokenClaims>(token.id_token, provider.jwksUrl, {
      issuer: provider.issuer,
      audience: clientId,
      fetch: doFetch,
    })
    if (!claims) return deny('id_token failed verification')
    // Replay protection: the id_token must answer the nonce *we* sent.
    if (claims.nonce !== nonce) return deny('id_token nonce mismatch')
    // An unverified address is a claim, not an identity — anyone can put
    // someone else's address on an account they haven't proved they own.
    if (claims.email_verified !== true || typeof claims.email !== 'string') return deny('no verified email')

    const signedIn = await gate.signIn(claims.email, request)
    // Authentication succeeded and authorization did not: the person is who
    // they say they are and still isn't allowed in. That distinction is what
    // lets an app pre-fill a request-access form with a *verified* address.
    if (!signedIn) {
      return new Response(null, {
        status: 302,
        headers: {
          location: `/?denied=${encodeURIComponent(claims.email)}`,
          'set-cookie': clearCookie({ name: nonceCookie, secure: isSecureRequest(request) }),
          'cache-control': 'no-store',
        },
      })
    }

    const headers = new Headers({ location: next, 'cache-control': 'no-store' })
    headers.append('set-cookie', signedIn.cookie)
    headers.append('set-cookie', clearCookie({ name: nonceCookie, secure: isSecureRequest(request) }))
    return new Response(null, { status: 302, headers })
  }
}

const deny = (why: string): Response =>
  new Response(`sign-in failed\n`, { status: 400, headers: { 'cache-control': 'no-store', 'x-oidc-reason': why } })

function readCookieValue(req: Request, name: string): string | null {
  const raw = req.headers.get('Cookie')
  if (!raw) return null
  for (const part of raw.split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim()
  }
  return null
}

/**
 * Google One Tap / FedCM — the same identity as the redirect flow, without the
 * two-page bounce. The browser hands us a Google-signed **id_token** in the
 * page (via GSI), the FE POSTs it here, and we verify it exactly as
 * `oidcCallback` does — this is that handler's second half (verify id_token →
 * `signIn`) exposed as a credential-in endpoint instead of a code-in one.
 *
 * The replay defence is the same storage-free trick as the redirect `state`:
 * `googleOneTapNonce` mints an HMAC-signed nonce, the page feeds it to GSI, and
 * the id_token comes back carrying it. Because the nonce is signed with the gate
 * secret, only a nonce *we* issued (and not yet expired) can satisfy a verify —
 * no server-side pending-nonce table required.
 */
export interface OneTapNonceOptions {
  gate: Gate
  /** How long the minted nonce is valid. Default 300s. */
  ttlS?: number
}

const ONETAP_PREFIX = 'onetap:'

/**
 * `GET` handler → `{ nonce }`. The page passes `nonce` to
 * `google.accounts.id.initialize({ nonce })` and echoes the same value back to
 * `googleOneTapVerify`. The value is opaque and single-window; it is not a
 * bearer credential (it authorizes nothing without a Google-signed id_token
 * that embeds it).
 */
export function googleOneTapNonce(opts: OneTapNonceOptions) {
  const { gate, ttlS = 300 } = opts
  return async (_ctx?: { request?: Request }): Promise<Response> => {
    const nonce = await signSession(`${ONETAP_PREFIX}${generateToken()}`, gate.secret, Date.now(), ttlS)
    return new Response(JSON.stringify({ nonce }) + '\n', {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    })
  }
}

export interface OneTapVerifyOptions {
  gate: Gate
  /** The OAuth client id; must equal the id_token `aud`. */
  clientId: string
  provider?: OidcProvider
  /**
   * Expose *why* a verify was denied in an `x-onetap-reason` header. Off by
   * default: the difference between "bad nonce" and "nonce mismatch" is only
   * useful to whoever is probing (the same reasoning as `oidcCallback`'s opaque
   * `deny`). Turn it on to debug a wiring problem, not in production.
   */
  debug?: boolean
  fetch?: typeof globalThis.fetch
}

/** Every SHA-256 encoding Google might use for the nonce claim, plus the raw value. */
async function nonceForms(nonce: string): Promise<Set<string>> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(nonce)))
  const b64u = b64uEncode(digest)
  const b64 = b64u.replace(/-/g, '+').replace(/_/g, '/')
  const hex = Array.from(digest, b => b.toString(16).padStart(2, '0')).join('')
  // Current GSI returns the raw nonce; the hashed forms cover the older
  // HTML-API behaviour. All derive from our signed nonce, so accepting several
  // encodings widens compatibility without weakening the binding.
  return new Set([nonce, b64u, b64, `${b64}=`, hex])
}

/**
 * `POST {credential, nonce}` handler. `credential` is a Google id_token, `nonce`
 * the value from `googleOneTapNonce`. On success the session is signed into
 * *this* response (`200`) — the page is already where it wants to be, so unlike
 * the redirect flow there is nothing to redirect to. A verified-but-not-allowed
 * identity returns `401 {denied: <email>}` so the FE can pre-fill request-access
 * with the Google-verified address.
 */
export function googleOneTapVerify(opts: OneTapVerifyOptions) {
  const { gate, clientId, provider = GOOGLE, debug = false } = opts
  const doFetch = opts.fetch ?? globalThis.fetch
  const deny = (why: string): Response => oneTapDeny(why, debug)

  return async ({ request }: { request: Request }): Promise<Response> => {
    const body = (await request.json().catch(() => ({}))) as { credential?: unknown; nonce?: unknown }
    const credential = typeof body.credential === 'string' ? body.credential : ''
    const nonce = typeof body.nonce === 'string' ? body.nonce : ''
    if (!credential || !nonce) return deny('missing credential or nonce')

    // The nonce must be one we minted and that hasn't expired.
    const sub = await verifySession(nonce, gate.secret, Date.now())
    if (!sub?.startsWith(ONETAP_PREFIX)) return deny('bad nonce')

    const claims = await verifyRs256Jwt<IdTokenClaims>(credential, provider.jwksUrl, {
      issuer: provider.issuer,
      audience: clientId,
      fetch: doFetch,
    })
    if (!claims) return deny('credential failed verification')
    // The id_token must answer the nonce we handed the page.
    if (typeof claims.nonce !== 'string' || !(await nonceForms(nonce)).has(claims.nonce)) {
      return deny('nonce mismatch')
    }
    if (claims.email_verified !== true || typeof claims.email !== 'string') return deny('no verified email')

    const signedIn = await gate.signIn(claims.email, request)
    if (!signedIn) {
      return new Response(JSON.stringify({ ok: false, denied: claims.email }) + '\n', {
        status: 401,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      })
    }
    return new Response(JSON.stringify({ ok: true }) + '\n', {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'set-cookie': signedIn.cookie,
      },
    })
  }
}

const oneTapDeny = (why: string, debug: boolean): Response =>
  new Response(JSON.stringify({ ok: false }) + '\n', {
    status: 401,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...(debug ? { 'x-onetap-reason': why } : {}),
    },
  })
