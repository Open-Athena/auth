/**
 * The `picture` claim for a face stored as a `data:` URI or an `asset://` ref:
 * a URL under the provider, good for as long as the token carrying it, that an
 * app fetches once and copies (`seedProfileFromClaims`).
 *
 * Why not the alternatives:
 * - the image itself would put up to 64 KB in every token;
 * - the IdP's URL (`lh3.googleusercontent.com`) is deliberately never stored;
 * - a permanent URL would be a public address for someone's face, sitting in
 *   whatever an app logs, and revoking one would need a table and a way to use it.
 *
 * The path segment is an encrypted ticket (AES-GCM) rather than a signed one, so
 * the URL doesn't show the email in a log. It's a bearer capability: anyone
 * holding the URL can fetch until it expires, with no cookie or client secret,
 * because the fetch is `copyAvatar`'s plain GET. What's served is read when the
 * request arrives, so a photo removed since the token was issued is gone.
 */
import { assetId, type StoredAsset } from '../core/assets.js'
import { InvalidImageError, parseAvatarRef, validateUploadedImage } from '../core/avatar.js'
import { b64uDecodeBytes, b64uEncode } from '../core/base64.js'

export interface PictureTicket {
  email: string
  clientId: string
  /** Epoch seconds. */
  expiresAt: number
}

const IV_BYTES = 12
/** Far beyond any real ticket: refused before any decoding or decryption. */
const MAX_TICKET_CHARS = 1024
const TICKET = /^[A-Za-z0-9_-]+$/
/**
 * Keys the ticket cipher, under the same secret as `sub`. `sub` values are public
 * and always HMAC an `e:` input, so this key can't be derived from one.
 */
const KEY_LABEL = 'oidc-picture-ticket-v1'

const enc = new TextEncoder()
const dec = new TextDecoder()

async function ticketKey(secret: string): Promise<CryptoKey> {
  const hmacKey = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const raw = await crypto.subtle.sign('HMAC', hmacKey, enc.encode(KEY_LABEL))
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

export function pictureTickets(secret: string) {
  let key: Promise<CryptoKey> | null = null
  const getKey = () => (key ??= ticketKey(secret))
  return {
    async seal({ email, clientId, expiresAt }: PictureTicket): Promise<string> {
      const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
      const body = enc.encode(JSON.stringify({ e: email, c: clientId, x: expiresAt }))
      const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await getKey(), body))
      const out = new Uint8Array(iv.length + sealed.length)
      out.set(iv)
      out.set(sealed, iv.length)
      return b64uEncode(out)
    },
    /** The ticket, or null if it's not one of ours. Expiry is the caller's to check. */
    async open(ticket: string): Promise<PictureTicket | null> {
      if (ticket.length > MAX_TICKET_CHARS || !TICKET.test(ticket)) return null
      // Anyone can send anything here, so a bad length or a failed decrypt is an
      // expected state: not a ticket.
      try {
        const bytes = b64uDecodeBytes(ticket)
        const body = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, IV_BYTES) }, await getKey(), bytes.subarray(IV_BYTES))
        const { e, c, x } = JSON.parse(dec.decode(body)) as { e: string; c: string; x: number }
        return { email: e, clientId: c, expiresAt: x }
      } catch {
        return null
      }
    },
  }
}

/** A stored face this route can serve: the kinds with no URL of their own. */
export const isHostedAvatar = (avatar: string): boolean => avatar.startsWith('data:') || assetId(avatar) !== null

/**
 * The stored face as an image response, or null if there's no such image or the
 * bytes aren't a raster image. The type is sniffed from the bytes, never taken
 * from the `data:` label or the asset's record.
 */
export async function pictureResponse(avatar: string, getAsset: (id: string) => Promise<StoredAsset | null>): Promise<Response | null> {
  const id = assetId(avatar)
  let bytes: Uint8Array | null = null
  try {
    if (id) bytes = (await getAsset(id))?.bytes ?? null
    else if (avatar.startsWith('data:')) {
      const ref = parseAvatarRef(avatar)
      bytes = ref.kind === 'upload' ? ref.bytes : null
    }
    if (!bytes) return null
    // Stored faces were capped when written, and an asset's cap is the gate's to
    // set: this call is only for the sniff.
    const { type } = validateUploadedImage(bytes, { maxBytes: bytes.length })
    return new Response(new Uint8Array(bytes), {
      headers: {
        'content-type': type,
        // The URL expires, so no cache may keep answering for it.
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
        // For an app's server to copy, not for a browser to render from here.
        'cross-origin-resource-policy': 'same-origin',
      },
    })
  } catch (e) {
    if (e instanceof InvalidImageError) return null
    throw e
  }
}
