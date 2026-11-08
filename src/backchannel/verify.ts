import { b64uDecodeString } from '../core/base64.js'
import { verifyRs256Jwt } from '../core/jwt.js'
import { hashToken } from '../core/tokens.js'
import type { LogoutEvidence } from './store.js'

export const LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout'
export const MAX_LOGOUT_TOKEN_BYTES = 8192

export interface LogoutVerifierOptions {
  issuer: string
  clientId: string
  jwksUrl: string
  fetch?: typeof globalThis.fetch
  /** Maximum exp - iat (default 120 seconds). */
  maxLifetimeS?: number
  /** Future iat allowance only; expiry is never extended (default 30 seconds). */
  clockSkewS?: number
}

const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const identifier = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 4096
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0

export function checkVerifierOptions(opts: LogoutVerifierOptions): void {
  for (const raw of [opts.issuer, opts.jwksUrl]) {
    const url = new URL(raw)
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new TypeError('HTTPS issuer/JWKS required')
  }
  if (!identifier(opts.clientId)) throw new TypeError('clientId required')
  if (!integer(opts.maxLifetimeS ?? 120) || (opts.maxLifetimeS ?? 120) < 1
    || !integer(opts.clockSkewS ?? 30)) throw new RangeError('invalid logout clock bounds')
}

/** Invalid credentials return null; configuration and dependency faults throw. No mutation. */
export async function verifyLogoutToken(
  token: string,
  opts: LogoutVerifierOptions,
  nowS = Math.floor(Date.now() / 1000),
): Promise<LogoutEvidence | null> {
  checkVerifierOptions(opts)
  if (!integer(nowS)) throw new RangeError('invalid verification time')
  if (token.length > MAX_LOGOUT_TOKEN_BYTES || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return null
  const [h, p] = token.split('.') as [string, string, string]
  let header: unknown
  let payload: unknown
  try {
    header = JSON.parse(b64uDecodeString(h))
    payload = JSON.parse(b64uDecodeString(p))
  } catch {
    return null
  }
  // These untrusted shapes can only reject; shared WebCrypto verification still authorizes every claim.
  if (!object(header) || !object(payload) || header.alg !== 'RS256' || header.typ !== 'logout+jwt'
    || !identifier(header.kid) || ['crit', 'jku', 'jwk', 'b64'].some(k => Object.hasOwn(header, k))) return null

  let fetchFailure = false
  const fetchKeys: typeof globalThis.fetch = async (_input, init) => {
    try {
      const response = await (opts.fetch ?? globalThis.fetch)(opts.jwksUrl, {
        ...init, redirect: 'error', signal: AbortSignal.timeout(5000),
      })
      if (!response.ok) throw new Error('JWKS unavailable')
      const text = await boundedText(response, 65536)
      const jwks: unknown = JSON.parse(text)
      if (!object(jwks) || !Array.isArray(jwks.keys) || !jwks.keys.every(k => object(k)
        && identifier(k.kid) && k.kty === 'RSA' && identifier(k.n) && identifier(k.e)
        && (k.alg === undefined || k.alg === 'RS256') && (k.use === undefined || k.use === 'sig'))) {
        throw new Error('invalid JWKS')
      }
      return new Response(text, { headers: { 'content-type': 'application/json' } })
    } catch {
      fetchFailure = true
      throw new Error('logout JWKS unavailable')
    }
  }
  const claims = await verifyRs256Jwt<Record<string, unknown>>(token, opts.jwksUrl, {
    issuer: opts.issuer, audience: opts.clientId, nowMs: nowS * 1000, fetch: fetchKeys,
  })
  if (fetchFailure) throw new Error('logout JWKS unavailable')
  if (!claims) return null
  const aud = claims.aud
  if (!(typeof aud === 'string' || (Array.isArray(aud) && aud.length > 0 && aud.every(identifier)))
    || !integer(claims.iat) || !integer(claims.exp) || claims.exp <= claims.iat
    || claims.exp - claims.iat > (opts.maxLifetimeS ?? 120) || claims.iat > nowS + (opts.clockSkewS ?? 30)
    || !identifier(claims.jti) || !identifier(claims.sid)
    || (claims.sub !== undefined && !identifier(claims.sub)) || Object.hasOwn(claims, 'nonce')
    || !object(claims.events) || !Object.hasOwn(claims.events, LOGOUT_EVENT) || !object(claims.events[LOGOUT_EVENT])) return null
  return {
    issuer: opts.issuer, clientId: opts.clientId, sid: claims.sid, sub: claims.sub as string | undefined ?? null,
    jti: claims.jti, digest: await hashToken(token), issuedAt: claims.iat, expiresAt: claims.exp,
  }
}

export class BodyTooLarge extends Error {}

export async function boundedText(source: { body: ReadableStream<Uint8Array> | null }, maxBytes: number): Promise<string> {
  if (!source.body) return ''
  const reader = source.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) {
        await reader.cancel()
        throw new BodyTooLarge('logout body too large')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return new TextDecoder().decode(bytes)
}
