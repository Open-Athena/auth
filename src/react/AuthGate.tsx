import type { ReactNode } from 'react'
import { type ExchangeOptions, useKeyExchange } from './exchange.js'
import { useWhoami } from './useWhoami.js'
import type { Whoami, WhoamiSource } from './types.js'

export interface AuthGateProps<T extends Whoami = Whoami> {
  source: WhoamiSource
  /** Rendered once an identity resolves. */
  children: ReactNode | ((whoami: T, refresh: () => void) => ReactNode)
  /** Rendered when nobody is signed in. */
  signIn: ReactNode | ((refresh: () => void) => ReactNode)
  /**
   * Rendered while probing. Default: nothing — the probe is one cached request,
   * and a spinner that flashes for 80ms reads worse than a blank moment.
   */
  loading?: ReactNode
  /** Redeem a `?key=` share link before probing. Pass false to disable. */
  exchange?: ExchangeOptions | false
}

/**
 * Probe identity, then render the app or the wall. Both tiers use this — marin
 * passes `{ kind: 'edge' }`, watchy passes `{ kind: 'app' }` — which is the
 * whole point of making the source a parameter.
 */
export function AuthGate<T extends Whoami = Whoami>({
  source,
  children,
  signIn,
  loading = null,
  exchange = {},
}: AuthGateProps<T>) {
  const ready = useKeyExchange(exchange)
  const { whoami, refresh } = useWhoami<T>(source, { enabled: ready })

  if (whoami === undefined) return <>{loading}</>
  if (whoami === null) return <>{typeof signIn === 'function' ? signIn(refresh) : signIn}</>
  return <>{typeof children === 'function' ? children(whoami, refresh) : children}</>
}
