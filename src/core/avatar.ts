/**
 * Faces for share links, resolved once when the link is minted.
 *
 * The point isn't decoration: a link that renders "Bob Smith" with Bob's face
 * is visibly *wrong* to whoever Bob forwards it to, which is the cheapest
 * discouragement of forwarding there is — and it costs nothing, because the
 * admin minting the link already knows who it's for.
 *
 * Resolution happens at mint time, on the server, deliberately:
 *
 * - hashing the recipient's address in *their* browser on every render would
 *   tell a third party that this person opened this private page, every time;
 * - the admin is a trusted supplier, unlike the stranger filling in the
 *   request form (see `cleanSubject`, which refuses an avatar outright);
 * - it resolves once instead of on every page view.
 *
 * Only two fixed hosts are ever fetched, so this is not an SSRF surface: a
 * caller-supplied `url` is validated and returned, never dereferenced here.
 */

/** Cap on an inlined image. Grants are read on every request for a link. */
export const MAX_INLINE_AVATAR_BYTES = 64 * 1024

export interface AvatarSource {
  /** Looked up on Gravatar, which is keyed by a hash of the address. */
  email?: string | null
  /** A GitHub handle (not a URL). */
  github?: string | null
  /** An explicit image URL, which wins over the other two. */
  url?: string | null
}

export interface ResolveAvatarOptions {
  /** Square pixels requested from the provider. Default 128. */
  size?: number
  /**
   * Fetch the image and return a `data:` URI instead of a URL. Removes the
   * third-party request from the recipient's browser entirely, at the cost of
   * a few KB on the grant row. Default false.
   */
  inline?: boolean
  maxBytes?: number
  /** Injectable for tests. */
  fetch?: typeof globalThis.fetch
}

/** GitHub's own rules: alphanumeric or single hyphens, not leading/trailing, ≤39. */
const GITHUB_HANDLE = /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/

export function isGithubHandle(handle: string): boolean {
  return GITHUB_HANDLE.test(handle)
}

/**
 * `https:` only, and no credentials in the URL. This value ends up as an
 * `<img src>` on an admin's screen and on every recipient's page.
 */
export function isSafeAvatarUrl(url: string): boolean {
  if (url.length > 2048) return false
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return parsed.protocol === 'https:' && !parsed.username && !parsed.password
}

const hex = (buf: ArrayBuffer): string =>
  [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')

/**
 * Gravatar's key is `SHA-256(trim(lowercase(email)))`. `d=404` is what makes
 * this a *lookup*: without it Gravatar always answers with a generated image,
 * and "has an avatar" becomes unknowable.
 */
export async function gravatarUrl(email: string, size = 128): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(email.trim().toLowerCase()))
  return `https://gravatar.com/avatar/${hex(digest)}?s=${size}&d=404`
}

/** GitHub redirects this to the CDN, and 404s for a handle nobody has. */
export function githubAvatarUrl(handle: string, size = 128): string {
  return `https://github.com/${encodeURIComponent(handle)}.png?size=${size}`
}

/**
 * The best avatar for a person, or `null` if there is none — which is a real
 * answer, not a failure: `<Avatar>` falls back to initials.
 */
export async function resolveAvatar(
  source: AvatarSource,
  { size = 128, inline = false, maxBytes = MAX_INLINE_AVATAR_BYTES, fetch = globalThis.fetch }: ResolveAvatarOptions = {},
): Promise<string | null> {
  const url = await candidate(source, size)
  if (!url) return null
  // An explicit URL is the admin's assertion, not a lookup: don't second-guess
  // it with a probe that a hotlink-protected host would fail anyway.
  if (url === source.url) return inline ? await inlineImage(url, maxBytes, fetch) : url
  if (inline) return await inlineImage(url, maxBytes, fetch)
  const res = await fetch(url, { method: 'GET', redirect: 'follow' }).catch(() => null)
  return res?.ok ? url : null
}

async function candidate(source: AvatarSource, size: number): Promise<string | null> {
  if (source.url) return isSafeAvatarUrl(source.url) ? source.url : null
  if (source.github) return isGithubHandle(source.github) ? githubAvatarUrl(source.github, size) : null
  if (source.email) return await gravatarUrl(source.email, size)
  return null
}

async function inlineImage(url: string, maxBytes: number, fetch: typeof globalThis.fetch): Promise<string | null> {
  const res = await fetch(url, { redirect: 'follow' }).catch(() => null)
  if (!res?.ok) return null
  const type = res.headers.get('content-type')?.split(';')[0]?.trim() ?? ''
  // Anything that isn't an image would be inlined into an `<img src>` on an
  // admin's page; refuse rather than hope the browser is careful.
  if (!type.startsWith('image/') || type === 'image/svg+xml') return null
  const bytes = new Uint8Array(await res.arrayBuffer())
  if (!bytes.length || bytes.length > maxBytes) return null
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return `data:${type};base64,${btoa(binary)}`
}
