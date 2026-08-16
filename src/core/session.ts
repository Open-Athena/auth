/**
 * First-party session cookies: `<b64u(claims)>.<b64u(HMAC-SHA256)>`.
 *
 * The claim shape `{v,sub,exp}` is deliberately standardized across consumers
 * (the cookie *name* is not) so a shared codec can read any app's session; see
 * specs/overview.md's "standardize the claim shape" question.
 *
 * `sub` is `e:<email>` for an SSO identity or `g:<grant_id>` for a share link.
 * Grant-backed subs carry no authority of their own: every request re-joins the
 * grant row, so revocation is instant (see `authenticate`).
 */
import { b64uDecodeBytes, b64uDecodeString, b64uEncode } from './base64.js'

export const DEFAULT_COOKIE_NAME = 'oa_auth'
export const DEFAULT_SESSION_TTL_S = 30 * 24 * 3600

const enc = new TextEncoder()

export interface SessionClaims {
  v: 1
  sub: string
  exp: number // epoch seconds
}

export const emailSub = (email: string): string => `e:${email}`
export const grantSub = (id: string): string => `g:${id}`

/** Split a `sub` into its kind and value, or null if it is not a shape we mint. */
export function parseSub(sub: string): { kind: 'email' | 'grant'; value: string } | null {
  if (sub.startsWith('e:')) return { kind: 'email', value: sub.slice(2) }
  if (sub.startsWith('g:')) return { kind: 'grant', value: sub.slice(2) }
  return null
}

async function hmacKey(secret: string, usages: ('sign' | 'verify')[]): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, usages)
}

export async function signSession(sub: string, secret: string, nowMs: number, ttlS = DEFAULT_SESSION_TTL_S): Promise<string> {
  const claims: SessionClaims = { v: 1, sub, exp: Math.floor(nowMs / 1000) + ttlS }
  const body = b64uEncode(enc.encode(JSON.stringify(claims)))
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret, ['sign']), enc.encode(body))
  return `${body}.${b64uEncode(sig)}`
}

/** Returns the `sub` claim, or null if the value is malformed, forged, or expired. */
export async function verifySession(value: string, secret: string, nowMs: number): Promise<string | null> {
  const i = value.indexOf('.')
  if (i < 0) return null
  const body = value.slice(0, i)
  let sig: Uint8Array
  let claims: unknown
  try {
    sig = b64uDecodeBytes(value.slice(i + 1))
  } catch {
    return null
  }
  // Verify before parsing: an unauthenticated payload never reaches JSON.parse.
  if (!(await crypto.subtle.verify('HMAC', await hmacKey(secret, ['verify']), sig, enc.encode(body)))) return null
  try {
    claims = JSON.parse(b64uDecodeString(body))
  } catch {
    return null
  }
  const { v, sub, exp } = (claims ?? {}) as Partial<SessionClaims>
  if (v !== 1 || typeof sub !== 'string' || typeof exp !== 'number') return null
  if (exp * 1000 < nowMs) return null
  return sub
}

export interface CookieOpts {
  name?: string
  ttlS?: number
  /** Defaults to true; pass the request's protocol so http://localhost still works. */
  secure?: boolean
  sameSite?: 'Lax' | 'Strict' | 'None'
  path?: string
}

function cookieAttrs({ secure = true, sameSite = 'Lax', path = '/' }: CookieOpts, maxAge: number): string {
  return `HttpOnly;${secure ? ' Secure;' : ''} SameSite=${sameSite}; Path=${path}; Max-Age=${maxAge}`
}

export function sessionCookie(value: string, opts: CookieOpts = {}): string {
  const { name = DEFAULT_COOKIE_NAME, ttlS = DEFAULT_SESSION_TTL_S } = opts
  return `${name}=${value}; ${cookieAttrs(opts, ttlS)}`
}

export function clearCookie(opts: CookieOpts = {}): string {
  const { name = DEFAULT_COOKIE_NAME } = opts
  return `${name}=; ${cookieAttrs(opts, 0)}`
}

export function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get('Cookie') ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === name) return v.join('=')
  }
  return null
}

/** `Secure` breaks cookies on plain-http dev origins, so derive it from the request. */
export const isSecureRequest = (req: Request): boolean => new URL(req.url).protocol === 'https:'
