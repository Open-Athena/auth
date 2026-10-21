import type { ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { SessionLossReason } from '../core/denial.js'
import { SessionLossContext } from './sessionLoss.js'
import { type ExchangeOptions, useKeyExchange } from './exchange.js'
import { WHOAMI_KEY, useWhoami } from './useWhoami.js'
import { DEFAULT_WHOAMI_ENDPOINT, type Whoami, type WhoamiSource } from './types.js'

export interface AuthGateProps<T extends Whoami = Whoami> {
  /** Where the gate's `/whoami` is mounted. Default `/api/auth/whoami`. */
  source?: WhoamiSource
  /** Rendered once an identity resolves. */
  children: ReactNode | ((whoami: T, refresh: () => void) => ReactNode)
  /** Rendered when nobody is signed in. */
  signIn: ReactNode | ((refresh: () => void, reason: SessionLossReason | null) => ReactNode)
  /** Periodic whoami revalidation in seconds. Off by default. */
  revalidateS?: number
  /**
   * Rendered while probing. Default: nothing — the probe is one cached request,
   * and a spinner that flashes for 80ms reads worse than a blank moment.
   */
  loading?: ReactNode
  /** Redeem a `?key=` share link before probing. Pass false to disable. */
  exchange?: ExchangeOptions | false
  /**
   * Stub the identity instead of probing — see `useWhoami`'s `devIdentity`.
   * `null` forces the wall; `undefined` (the default) probes normally.
   */
  devIdentity?: T | null
}

/** Probe identity, then render the app or the wall. */
export function AuthGate<T extends Whoami = Whoami>({
  source = {},
  children,
  signIn,
  loading = null,
  exchange = {},
  devIdentity,
  revalidateS,
}: AuthGateProps<T>) {
  const client = useQueryClient()
  const ready = useKeyExchange(exchange, async exchanged => {
    if (!exchanged || devIdentity !== undefined) return
    // A sibling observer may still be probing the cookie from before redemption.
    const filters = { queryKey: [...WHOAMI_KEY, source.endpoint ?? DEFAULT_WHOAMI_ENDPOINT], exact: true }
    await client.cancelQueries(filters)
    await client.invalidateQueries(filters)
  })
  const { whoami, refresh, reason } = useWhoami<T>(source, { enabled: ready, devIdentity, revalidateS })

  if ((!ready && devIdentity === undefined) || whoami === undefined) return <>{loading}</>
  if (whoami === null) return (
    <SessionLossContext.Provider value={reason}>
      {typeof signIn === 'function' ? signIn(refresh, reason) : signIn}
    </SessionLossContext.Provider>
  )
  return <>{typeof children === 'function' ? children(whoami, refresh) : children}</>
}
