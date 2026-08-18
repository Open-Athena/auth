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
export function useForgetWhoami() {
    const client = useQueryClient();
    return () => void client.resetQueries({ queryKey: WHOAMI_KEY });
}
