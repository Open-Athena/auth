/**
 * Capability tokens (share links / magic links) and grant ids.
 *
 * Tokens are full-entropy random values stored hashed at rest (SHA-256,
 * base64url). SHA-256 rather than a password KDF is correct here precisely
 * because the input is random: there is no dictionary to search, so an
 * attacker gains nothing over guessing the raw token. Swap for argon2 only if
 * human-chosen secrets ever enter this path.
 */
import { b64uEncode } from './base64.js'

const TOKEN_BYTES = 24 // 192 bits; base64url -> 32 chars
const ID_BYTES = 9 // 72 bits; base64url -> 12 chars. Not a secret, just unguessable.

const enc = new TextEncoder()

function random(n: number): string {
  const bytes = new Uint8Array(n)
  crypto.getRandomValues(bytes)
  return b64uEncode(bytes)
}

/** A fresh share-link token. Shown to the minter exactly once; only its hash is stored. */
export const generateToken = (): string => random(TOKEN_BYTES)

/**
 * A fresh grant id. Random rather than autoincrement so ids in URLs and audit
 * rows don't leak how many grants exist or let one be guessed from another.
 */
export const generateId = (): string => random(ID_BYTES)

export async function hashToken(token: string): Promise<string> {
  return b64uEncode(await crypto.subtle.digest('SHA-256', enc.encode(token)))
}

/**
 * HMAC a client IP so access-log rows correlate without storing raw addresses.
 * Keyed (not a bare hash) because the IPv4 space is small enough to enumerate.
 */
export async function hashIp(ip: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return b64uEncode(await crypto.subtle.sign('HMAC', key, enc.encode(ip)))
}
