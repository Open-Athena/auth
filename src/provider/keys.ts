/**
 * The provider's signing keys: RS256, because every relying party here
 * (`verifyRs256Jwt`) and most of the world's OIDC clients expect it.
 *
 * Keys are private RSA JWKs with a `kid`, passed in from a Worker secret. The
 * first one signs; all are published, so rotation is "prepend a new key,
 * deploy, wait out the longest token and JWKS cache lifetime, drop the old".
 */
import { b64uDecodeBytes, b64uDecodeString, b64uEncode } from '../core/base64.js'

/** A private RSA JWK with its key id (`generateSigningKey`'s output). */
export type SigningJwk = JsonWebKey & { kid: string }

/** A public JWK as published at the JWKS endpoint. */
export type PublicJwk = { kty: 'RSA'; n: string; e: string; kid: string; alg: 'RS256'; use: 'sig' }

const ALG = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const
const enc = new TextEncoder()

/** A fresh 2048-bit RS256 key, as a private JWK. Store it as a secret; never log it. */
export async function generateSigningKey(kid = `k${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`): Promise<SigningJwk> {
  const pair = (await crypto.subtle.generateKey(
    { ...ALG, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair
  const jwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey
  return { ...jwk, kid, alg: 'RS256' }
}

export interface KeySet {
  /** The published half of every key. */
  jwks: { keys: PublicJwk[] }
  /** Sign a JWT with the current (first) key. */
  sign(payload: Record<string, unknown>, typ?: string): Promise<string>
  /**
   * The payload of a JWT one of these keys signed, or null. Checks only the
   * signature and `alg`: claims (`iss`, `aud`, `exp`) are the caller's, since
   * a logout's `id_token_hint` is accepted past its `exp` and an access token
   * isn't.
   */
  verify<T extends Record<string, unknown>>(jwt: string): Promise<T | null>
}

/** Import the keys once; the result signs and verifies. */
export function keySet(keys: SigningJwk[]): KeySet {
  if (!keys.length) throw new Error('an OIDC provider needs at least one signing key')
  const kids = new Set<string>()
  for (const k of keys) {
    if (k.kty !== 'RSA' || !k.d) throw new Error(`signing key ${k.kid}: not a private RSA JWK`)
    if (kids.has(k.kid)) throw new Error(`signing key ${k.kid}: duplicate kid`)
    kids.add(k.kid)
  }
  const pub = (k: SigningJwk): PublicJwk => ({ kty: 'RSA', n: k.n!, e: k.e!, kid: k.kid, alg: 'RS256', use: 'sig' })
  const jwks = { keys: keys.map(pub) }
  const strip = ({ kid: _kid, alg: _alg, key_ops: _ops, use: _use, ...k }: SigningJwk): JsonWebKey => k
  const signer = crypto.subtle.importKey('jwk', strip(keys[0]!), ALG, false, ['sign'])
  const verifiers = new Map(keys.map(k => [k.kid, crypto.subtle.importKey('jwk', pub(k), ALG, false, ['verify'])]))

  return {
    jwks,
    async sign(payload, typ = 'JWT') {
      const header = b64uEncode(enc.encode(JSON.stringify({ alg: 'RS256', kid: keys[0]!.kid, typ })))
      const body = b64uEncode(enc.encode(JSON.stringify(payload)))
      const sig = await crypto.subtle.sign(ALG.name, await signer, enc.encode(`${header}.${body}`))
      return `${header}.${body}.${b64uEncode(sig)}`
    },
    async verify<T extends Record<string, unknown>>(jwt: string): Promise<T | null> {
      const parts = jwt.split('.')
      if (parts.length !== 3) return null
      const [h, p, s] = parts as [string, string, string]
      let header: { alg?: unknown; kid?: unknown }
      try {
        header = JSON.parse(b64uDecodeString(h)) as typeof header
      } catch {
        return null
      }
      if (header.alg !== 'RS256' || typeof header.kid !== 'string') return null
      const key = verifiers.get(header.kid)
      if (!key) return null
      let ok: boolean
      try {
        ok = await crypto.subtle.verify(ALG.name, await key, b64uDecodeBytes(s), enc.encode(`${h}.${p}`))
      } catch {
        return null
      }
      if (!ok) return null
      try {
        const claims = JSON.parse(b64uDecodeString(p)) as unknown
        return claims && typeof claims === 'object' && !Array.isArray(claims) ? (claims as T) : null
      } catch {
        return null
      }
    },
  }
}
