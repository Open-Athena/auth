import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DEFAULT_ENDPOINTS } from './types.js';
export const WHOAMI_KEY = ['oa-auth', 'whoami'];
/**
 * Probe the current identity from either source. `retry: false` because a 401
 * is a real answer, not a transient failure — retrying it just delays the wall.
 */
export function useWhoami(source, { staleTime = 5 * 60_000, enabled = true, devIdentity } = {}) {
    const client = useQueryClient();
    const endpoint = source.endpoint ?? DEFAULT_ENDPOINTS[source.kind];
    const stubbed = devIdentity !== undefined;
    const query = useQuery({
        queryKey: [...WHOAMI_KEY, source.kind, endpoint],
        enabled: enabled && !stubbed,
        staleTime,
        retry: false,
        queryFn: async () => {
            const res = await fetch(endpoint, { credentials: 'include', headers: { accept: 'application/json' } });
            // "Not signed in" arrives as a status, not an exception.
            if (res.status === 401 || res.status === 403 || res.status === 404)
                return null;
            if (!res.ok)
                throw new Error(`whoami failed: ${res.status}`);
            return (await res.json());
        },
    });
    if (stubbed)
        return { whoami: devIdentity, refresh: () => { }, error: null };
    return {
        whoami: enabled && query.isPending ? undefined : (query.data ?? null),
        refresh: () => void client.invalidateQueries({ queryKey: WHOAMI_KEY }),
        error: query.error ?? null,
    };
}
/** Drop any cached identity — call after signing out so the wall appears at once. */
export function useForgetWhoami() {
    const client = useQueryClient();
    return () => void client.removeQueries({ queryKey: WHOAMI_KEY });
}
