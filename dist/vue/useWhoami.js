import { getCurrentInstance, onMounted, onScopeDispose, shallowReadonly, shallowRef } from 'vue';
import { AuthClientError, createAuthClient } from '../client/api.js';
import { exchangeKeyParam, hasKeyParam } from '../client/exchange.js';
function createState(client) {
    const whoami = shallowRef();
    const loading = shallowRef(true);
    const error = shallowRef(null);
    let generation = 0;
    let updated = 0;
    let pending;
    let logout;
    let users = 0;
    const asError = (value) => value instanceof Error ? value : new Error(String(value));
    function refetch() {
        if (logout)
            return logout;
        const request = ++generation;
        loading.value = true;
        error.value = null;
        const task = (async () => {
            try {
                const identity = await client.whoami();
                if (request === generation) {
                    whoami.value = identity;
                    updated = Date.now();
                }
            }
            catch (cause) {
                if (request !== generation)
                    return;
                whoami.value = null;
                if (!(cause instanceof AuthClientError && cause.status === 401))
                    error.value = asError(cause);
                updated = Date.now();
            }
            finally {
                if (request === generation) {
                    loading.value = false;
                    pending = undefined;
                }
            }
        })();
        pending = task;
        return task;
    }
    function signOut() {
        if (logout)
            return logout;
        ++generation;
        pending = undefined;
        loading.value = true;
        error.value = null;
        logout = (async () => {
            try {
                await client.logout();
                if (users)
                    whoami.value = null;
            }
            catch (cause) {
                if (users)
                    error.value = asError(cause);
                throw cause;
            }
            finally {
                if (users)
                    loading.value = false;
                logout = undefined;
            }
        })();
        return logout;
    }
    return {
        result: { whoami: shallowReadonly(whoami), loading: shallowReadonly(loading), error: shallowReadonly(error), refetch, signOut },
        retain() { users++; },
        release() {
            if (--users === 0) {
                ++generation;
                pending = undefined;
                whoami.value = undefined;
                error.value = null;
                loading.value = true;
                // Keep the entry while logout is in flight so a remount waits for it.
                return !logout;
            }
            return false;
        },
        ensure(staleTime) {
            // Background observers wait for logout; its error is already in state.
            // The explicit signOut caller still receives the rejection.
            if (logout)
                return logout.then(() => { }, () => { });
            if (pending)
                return pending;
            if (whoami.value == null || error.value || Date.now() - updated >= staleTime)
                return refetch();
            return Promise.resolve();
        },
        exchanged() {
            ++generation;
            pending = undefined;
            whoami.value = undefined;
            if (users && !logout)
                void refetch();
        },
    };
}
// App keys are weak: neither identities nor credentials are shared across apps/SSR requests.
const apps = new WeakMap();
const exchanges = new WeakMap();
export function useWhoami(options = {}) {
    const instance = getCurrentInstance();
    if (!instance)
        throw new Error('useWhoami must be called during component setup');
    const app = instance.appContext.app;
    const basePath = (options.basePath ?? '/api/auth').replace(/\/+$/, '');
    const entries = apps.get(app) ?? [];
    apps.set(app, entries);
    let entry = entries.find(item => options.client
        ? item.client === options.client
        : !item.client && item.basePath === basePath && item.fetch === options.fetch);
    if (!entry) {
        entry = { client: options.client, basePath, fetch: options.fetch, state: createState(options.client ?? createAuthClient(options)) };
        entries.push(entry);
    }
    const { state } = entry;
    state.retain();
    let active = true;
    let ready = false;
    const refresh = () => {
        if (active && ready)
            void state.ensure(options.staleTime ?? 5 * 60_000);
    };
    onMounted(async () => {
        if (options.exchange !== undefined && options.exchange !== false) {
            const opts = { endpoint: `${basePath}/exchange`, ...options.exchange };
            const key = JSON.stringify([opts.endpoint, opts.param ?? 'key']);
            const map = exchanges.get(app) ?? new Map();
            exchanges.set(app, map);
            let exchange = map.get(key);
            if (!exchange) {
                const claimed = hasKeyParam(opts);
                exchange = exchangeKeyParam(opts);
                map.set(key, exchange);
                void exchange.finally(() => {
                    if (map.get(key) === exchange)
                        map.delete(key);
                    // A non-exchanging consumer may have probed using the previous cookie.
                    // Invalidate even a fresh result and supersede any pre-exchange probe.
                    if (claimed)
                        entries.forEach(item => item.state.exchanged());
                });
            }
            await exchange;
        }
        if (!active)
            return;
        ready = true;
        refresh();
        window.addEventListener('focus', refresh);
        document.addEventListener('visibilitychange', visible);
    });
    function visible() { if (document.visibilityState === 'visible')
        refresh(); }
    onScopeDispose(() => {
        active = false;
        if (typeof window !== 'undefined')
            window.removeEventListener('focus', refresh);
        if (typeof document !== 'undefined')
            document.removeEventListener('visibilitychange', visible);
        if (state.release()) {
            const index = entries.indexOf(entry);
            if (index !== -1)
                entries.splice(index, 1);
        }
    });
    return state.result;
}
