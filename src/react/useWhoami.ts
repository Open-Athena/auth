import { useQuery, useQueryClient } from '@tanstack/react-query'
import { DEFAULT_ENDPOINTS, type Whoami, type WhoamiSource } from './types.js'

export const WHOAMI_KEY = ['oa-auth', 'whoami'] as const

export interface UseWhoamiOptions {
  /** Default 5 minutes. Identity rarely changes mid-session; the gate re-checks server-side anyway. */
  staleTime?: number
  /** Hold the probe until a `?key=` exchange has finished. */
  enabled?: boolean
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
  { staleTime = 5 * 60_000, enabled = true }: UseWhoamiOptions = {},
): UseWhoamiResult<T> {
  const client = useQueryClient()
  const endpoint = source.endpoint ?? DEFAULT_ENDPOINTS[source.kind]

  const query = useQuery<T | null>({
    queryKey: [...WHOAMI_KEY, source.kind, endpoint],
    enabled,
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

  return {
    whoami: enabled && query.isPending ? undefined : (query.data ?? null),
    refresh: () => void client.invalidateQueries({ queryKey: WHOAMI_KEY }),
    error: (query.error as Error | null) ?? null,
  }
}

/** Drop any cached identity — call after signing out so the wall appears at once. */
export function useForgetWhoami(): () => void {
  const client = useQueryClient()
  return () => void client.removeQueries({ queryKey: WHOAMI_KEY })
}
