export interface ExchangeOptions {
  /** Query param carrying the token (the gate's `keyParam`; a list accepts each, the first present wins). Default `key`. */
  param?: string | readonly string[]
  /** Default `/api/auth/exchange`. */
  endpoint?: string
}

const names = (param: string | readonly string[]): readonly string[] => typeof param === 'string' ? [param] : param

export const hasKeyParam = ({ param = 'key' }: ExchangeOptions = {}): boolean =>
  typeof window !== 'undefined' && names(param).some(p => new URL(window.location.href).searchParams.has(p))

/**
 * Trade a `?key=<token>` share link for a session cookie.
 *
 * The token is claimed — read *and* stripped from the URL — synchronously,
 * before the network call. Two reasons, both learned the hard way:
 *
 *  - A token left in the URL survives in history, in the back button, and in
 *    whatever the recipient copy-pastes onward. It goes as early as possible,
 *    and it goes whether or not the exchange succeeds.
 *  - Stripping first makes this function self-idempotent. A second concurrent
 *    call (React StrictMode double-invokes effects; so does any remount) finds
 *    no token and does nothing, instead of spending a second redemption.
 *    Redemptions are the forwarding signal — double-counting them makes the
 *    admin view lie about how widely a link travelled.
 */
export async function exchangeKeyParam(opts: ExchangeOptions = {}): Promise<boolean> {
  const { param = 'key', endpoint = '/api/auth/exchange' } = opts
  if (typeof window === 'undefined') return false
  const url = new URL(window.location.href)
  const token = names(param).map(p => url.searchParams.get(p)).find(v => v !== null)
  if (!token) return false
  for (const p of names(param)) url.searchParams.delete(p)
  window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`)
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    })
    return res.ok
  } catch {
    return false
  }
}
