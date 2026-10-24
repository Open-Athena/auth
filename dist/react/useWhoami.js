import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { subscribeUnauthenticated } from '../client/auth-events.js';
import { isSessionLossReason } from '../core/denial.js';
import { DEFAULT_WHOAMI_ENDPOINT } from './types.js';
export const WHOAMI_KEY = ['oa-auth', 'whoami'];
const REASON_KEY = ['oa-auth', 'session-loss'];
const subscriptions = new WeakMap();
/** Share event side effects, just as TanStack shares the identity query. */
function retainRevalidation(client, endpoint) {
    let endpoints = subscriptions.get(client);
    if (!endpoints) {
        endpoints = new Map();
        subscriptions.set(client, endpoints);
    }
    let subscription = endpoints.get(endpoint);
    if (!subscription) {
        const revalidate = () => {
            void client.cancelQueries({ queryKey: [...WHOAMI_KEY, endpoint], exact: true });
            void client.invalidateQueries({ queryKey: [...WHOAMI_KEY, endpoint], exact: true });
        };
        const unsubscribe = subscribeUnauthenticated(event => {
            if (event.endpoint !== endpoint)
                return;
            if (event.reason)
                client.setQueryData([...REASON_KEY, endpoint], event.reason);
            revalidate();
        });
        const onVisibility = () => {
            if (document.visibilityState === 'visible')
                revalidate();
        };
        document.addEventListener('visibilitychange', onVisibility);
        subscription = {
            observers: 0,
            revalidate,
            dispose: () => {
                unsubscribe();
                document.removeEventListener('visibilitychange', onVisibility);
            },
        };
        endpoints.set(endpoint, subscription);
    }
    subscription.observers++;
    const retained = subscription;
    return {
        revalidate: retained.revalidate,
        release: () => {
            if (--retained.observers === 0) {
                retained.dispose();
                endpoints.delete(endpoint);
            }
        },
    };
}
/**
 * Probe the current identity. `retry: false` because a 401
 * is a real answer, not a transient failure — retrying it just delays the wall.
 */
export function useWhoami(source = {}, { staleTime = 5 * 60_000, enabled = true, devIdentity, revalidateS } = {}) {
    const client = useQueryClient();
    const endpoint = source.endpoint ?? DEFAULT_WHOAMI_ENDPOINT;
    const stubbed = devIdentity !== undefined;
    const reasonKey = [...REASON_KEY, endpoint];
    const { data: reason = null } = useQuery({
        queryKey: reasonKey,
        queryFn: () => null,
        enabled: false,
        initialData: null,
    });
    useEffect(() => {
        if (!enabled || stubbed)
            return;
        const { revalidate, release } = retainRevalidation(client, endpoint);
        const timer = revalidateS && revalidateS > 0 ? setInterval(revalidate, revalidateS * 1000) : undefined;
        return () => {
            release();
            if (timer !== undefined)
                clearInterval(timer);
        };
    }, [client, endpoint, enabled, stubbed, revalidateS]);
    const query = useQuery({
        queryKey: [...WHOAMI_KEY, endpoint],
        enabled: enabled && !stubbed,
        /**
         * Fresh while signed in, always stale while signed out. Someone sitting on
         * the wall may have just redeemed a link *in another tab* — the cookie is
         * browser-wide, so this tab only has to look again — while a signed-in page
         * has no such reason to re-probe. Together with `refetchOnWindowFocus` this
         * replaces the "I just opened a link — retry" button, which was a
         * workaround wearing a feature's clothes.
         */
        staleTime: q => (q.state.data == null ? 0 : staleTime),
        refetchOnWindowFocus: true,
        retry: false,
        queryFn: async ({ signal }) => {
            const res = await fetch(endpoint, { signal, credentials: 'include', headers: { accept: 'application/json' } });
            // "Not signed in" arrives as a status, not an exception.
            if (res.status === 401 || res.status === 403 || res.status === 404) {
                const body = await res.text()
                    .then(text => { try {
                    return JSON.parse(text);
                }
                catch {
                    return null;
                } });
                signal.throwIfAborted();
                if (body && typeof body === 'object' && 'reason' in body && isSessionLossReason(body.reason)) {
                    client.setQueryData(reasonKey, body.reason);
                }
                return null;
            }
            if (!res.ok)
                throw new Error(`whoami failed: ${res.status}`);
            const identity = (await res.json());
            signal.throwIfAborted();
            client.setQueryData(reasonKey, null);
            return identity;
        },
    });
    if (stubbed)
        return { whoami: devIdentity, reason: null, refresh: () => { }, error: null };
    return {
        reason: query.data === null ? reason : null,
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
    return () => {
        client.setQueriesData({ queryKey: REASON_KEY }, null);
        void client.resetQueries({ queryKey: WHOAMI_KEY });
    };
}
