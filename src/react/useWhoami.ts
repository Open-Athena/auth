import { useQuery, useQueryClient } from '@tanstack/react-query'
import { DEFAULT_ENDPOINTS, type Whoami, type WhoamiSource } from './types.js'

export const WHOAMI_KEY = ['oa-auth', 'whoami'] as const

export interface UseWhoamiOptions<T> {
  /** Default 5 minutes. Identity rarely changes mid-session; the gate re-checks server-side anyway. */
  staleTime?: number
  /** Hold the probe until a `?key=` exchange has finished. */
  enabled?: boolean
  /**
   * Skip the probe and use this identity instead. For local development against
   * a Tier-1 (edge) source, where `/cdn-cgi/access/get-identity` doesn't exist
   * and every page would otherwise show the wall.
   *
   * The *policy* stays in the app, which is the only place that knows its own
   * build flags:
   *
   * ```ts
   * devIdentity: import.meta.env.DEV && !forceWall ? { email: 'dev@example.test' } : undefined
   * ```
   *
   * `undefined` probes normally; `null` forces the signed-out state (handy for
   * eyeballing the wall without a deploy). It can only ever loosen the *client*
   * — the server gate is unaffected, so this can't grant real access.
   */
  devIdentity?: T | null
}

export interface UseWhoamiResult<T> {
  /** `undefined` while loading, `null` when signed out, else the identity. */
  whoami: T | null | undefined
  refresh: () => void
  error: Error | null
}

/**
 * Probe the current identity from either source. `retry: false` because a 401
 * is a real answer, not a transient failure — retrying it just delays the wall.
 */
export function useWhoami<T extends Whoami = Whoami>(
  source: WhoamiSource,
  { staleTime = 5 * 60_000, enabled = true, devIdentity }: UseWhoamiOptions<T> = {},
): UseWhoamiResult<T> {
  const client = useQueryClient()
  const endpoint = source.endpoint ?? DEFAULT_ENDPOINTS[source.kind]
  const stubbed = devIdentity !== undefined

  const query = useQuery<T | null>({
    queryKey: [...WHOAMI_KEY, source.kind, endpoint],
    enabled: enabled && !stubbed,
    staleTime,
    retry: false,
    queryFn: async () => {
      const res = await fetch(endpoint, { credentials: 'include', headers: { accept: 'application/json' } })
      // "Not signed in" arrives as a status, not an exception.
      if (res.status === 401 || res.status === 403 || res.status === 404) return null
      if (!res.ok) throw new Error(`whoami failed: ${res.status}`)
      return (await res.json()) as T
    },
  })

  if (stubbed) return { whoami: devIdentity, refresh: () => {}, error: null }

  return {
    whoami: enabled && query.isPending ? undefined : (query.data ?? null),
    refresh: () => void client.invalidateQueries({ queryKey: WHOAMI_KEY }),
    error: (query.error as Error | null) ?? null,
  }
}

/**
 * Drop any cached identity — call after signing out so the wall appears at once.
 *
 * `resetQueries`, not `removeQueries`: removing a query notifies *cache*-level
 * subscribers, while a `QueryObserver` subscribes to the query itself, so no
 * mounted component ever hears about it and the page keeps rendering the
 * identity you just dropped. That failure looks like a security bug from the
 * outside even though the session is genuinely dead server-side — watchy hit
 * exactly this. `removeQueries` is only correct for queries nobody is watching.
 *
 * Resetting also refetches active observers, so the signed-out state is
 * confirmed by the server rather than assumed.
 */
export function useForgetWhoami(): () => void {
  const client = useQueryClient()
  return () => void client.resetQueries({ queryKey: WHOAMI_KEY })
}
