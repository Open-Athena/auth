import { useEffect, useState } from 'react'

export interface ExchangeOptions {
  /** Query param carrying the token. Default `key`. */
  param?: string
  /** Default `/api/auth/exchange`. */
  endpoint?: string
}

export const hasKeyParam = ({ param = 'key' }: ExchangeOptions = {}): boolean =>
  typeof window !== 'undefined' && new URL(window.location.href).searchParams.has(param)

/**
 * Trade a `?key=<token>` share link for a session cookie, then strip the param.
 *
 * The strip happens whether or not the exchange succeeded: a token left in the
 * URL survives in history, in the back button, and in whatever the recipient
 * copy-pastes to the next person — which is precisely the leak share links are
 * supposed to make revocable rather than silent.
 */
export async function exchangeKeyParam(opts: ExchangeOptions = {}): Promise<boolean> {
  const { param = 'key', endpoint = '/api/auth/exchange' } = opts
  if (typeof window === 'undefined') return false
  const url = new URL(window.location.href)
  const token = url.searchParams.get(param)
  if (!token) return false
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
  } finally {
    url.searchParams.delete(param)
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`)
  }
}

/**
 * Run the exchange once on mount if a token is present. Returns whether the
 * identity probe may proceed — false only for the moment the exchange is in
 * flight, so the wall never flashes before a valid link has been redeemed.
 */
export function useKeyExchange(opts: ExchangeOptions | false = {}): boolean {
  const [ready, setReady] = useState(() => opts === false || !hasKeyParam(opts))
  useEffect(() => {
    if (ready) return
    let live = true
    void exchangeKeyParam(opts === false ? {} : opts).finally(() => {
      if (live) setReady(true)
    })
    return () => {
      live = false
    }
    // Mount-only by design: the token is stripped from the URL on the first run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return ready
}
