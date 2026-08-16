import { Fragment as _Fragment, jsx as _jsx } from "react/jsx-runtime";
import { useKeyExchange } from './exchange.js';
import { useWhoami } from './useWhoami.js';
/**
 * Probe identity, then render the app or the wall. Both tiers use this — marin
 * passes `{ kind: 'edge' }`, watchy passes `{ kind: 'app' }` — which is the
 * whole point of making the source a parameter.
 */
export function AuthGate({ source, children, signIn, loading = null, exchange = {}, }) {
    const ready = useKeyExchange(exchange);
    const { whoami, refresh } = useWhoami(source, { enabled: ready });
    if (whoami === undefined)
        return _jsx(_Fragment, { children: loading });
    if (whoami === null)
        return _jsx(_Fragment, { children: typeof signIn === 'function' ? signIn(refresh) : signIn });
    return _jsx(_Fragment, { children: typeof children === 'function' ? children(whoami, refresh) : children });
}
