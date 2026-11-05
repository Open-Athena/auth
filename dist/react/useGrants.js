import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { createGrantsController } from '../client/grants.js';
/**
 * `createGrantsController` as a hook, loading the list on mount. `client` must be
 * stable (a new one is a new controller, losing any one-time token). Pass your
 * own `controller` to keep a token across this component unmounting.
 */
export function useGrants({ client, controller: given, pollMs }) {
    const controller = useMemo(() => given ?? createGrantsController({ client: client }), [given, client]);
    const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
    useEffect(() => {
        void controller.refresh();
        if (!pollMs)
            return;
        const timer = setInterval(() => {
            if (document.visibilityState === 'visible')
                void controller.refresh();
        }, pollMs);
        return () => clearInterval(timer);
    }, [controller, pollMs]);
    const { subscribe: _subscribe, getSnapshot: _getSnapshot, ...actions } = controller;
    return { ...snapshot, ...actions };
}
