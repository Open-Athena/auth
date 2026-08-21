/**
 * RS256 JWT verification against a JWKS endpoint — the one piece every OIDC
 * issuer needs and every one of them does identically.
 *
 * Extracted from the Cloudflare Access adapter when a second issuer (Google)
 * appeared. One copy of "check the signature before trusting the payload"
 * matters more than most shared code: two copies drift, and the copy that
 * drifts is a signature check.
 */
import { b64uDecodeBytes, b64uDecodeString } from './base64.js'

const enc = new TextEncoder()

interface JwtHeader {
  alg?: string
  kid?: string
}

export interface VerifyJwtOptions {
  /** Required `iss` claim. */
  issuer: string | string[]
  /** Required `aud` claim, when the issuer scopes tokens to a client. */
  audience?: string
  nowMs?: number
  /** Seconds to cache the JWKS response at the edge. Cloudflare-specific; ignored elsewhere. */
  cacheTtlS?: number
  fetch?: typeof globalThis.fetch
}

/**
 * The verified claims, or null. Null covers every failure — malformed, wrong
 * algorithm, unknown key, bad signature, wrong issuer/audience, expired —
 * because a caller can do nothing useful with the distinction, and reporting it
 * back to whoever presented the token is an oracle.
 */
export async function verifyRs256Jwt<T extends Record<string, unknown>>(
  jwt: string,
  jwksUrl: string,
  { issuer, audience, nowMs = Date.now(), cacheTtlS = 3600, fetch = globalThis.fetch }: VerifyJwtOptions,
): Promise<T | null> {
  const parts = jwt.split('.')
  if (parts.length !== 3) return null
  const [h, p, s] = parts as [string, string, string]

  let header: JwtHeader
  try {
    header = JSON.parse(b64uDecodeString(h)) as JwtHeader
  } catch {
    return null
  }
  // Pinned, not read from the token: accepting the token's own `alg` is how
  // `alg: none` and HMAC-with-the-public-key forgeries get in.
  if (header.alg !== 'RS256') return null

  const certs = (await fetch(jwksUrl, { cf: { cacheTtl: cacheTtlS } } as RequestInit)
    .then(r => (r.ok ? (r.json() as Promise<{ keys: (JsonWebKey & { kid: string })[] }>) : null))
    .catch(() => null)) as { keys: (JsonWebKey & { kid: string })[] } | null
  const jwk = certs?.keys?.find(k => k.kid === header.kid)
  if (!jwk) return null

  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])
  let ok: boolean
  try {
    ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64uDecodeBytes(s), enc.encode(`${h}.${p}`))
  } catch {
    return null
  }
  // Verify before parsing: an unauthenticated payload never reaches JSON.parse.
  if (!ok) return null

  let claims: T
  try {
    claims = JSON.parse(b64uDecodeString(p)) as T
  } catch {
    return null
  }

  const issuers = Array.isArray(issuer) ? issuer : [issuer]
  if (typeof claims.iss !== 'string' || !issuers.includes(claims.iss)) return null
  // `<=` so expiry is judged identically everywhere — grants, sessions, and
  // every JWT: "exactly at exp" is expired.
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= nowMs) return null
  if (audience) {
    const aud = claims.aud
    if (!(Array.isArray(aud) ? aud : [aud]).includes(audience)) return null
  }
  return claims
}
