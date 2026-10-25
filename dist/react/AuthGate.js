import { Fragment as _Fragment, jsx as _jsx } from "react/jsx-runtime";
import { useQueryClient } from '@tanstack/react-query';
import { SessionLossContext } from './sessionLoss.js';
import { announceSelectionChange } from '../client/accounts.js';
import { ACCOUNTS_KEY } from './Accounts.js';
import { useKeyExchange } from './exchange.js';
import { WHOAMI_KEY, useWhoami } from './useWhoami.js';
import { DEFAULT_WHOAMI_ENDPOINT } from './types.js';
/** Probe identity, then render the app or the wall. */
export function AuthGate({ source = {}, children, signIn, loading = null, exchange = {}, devIdentity, revalidateS, }) {
    const client = useQueryClient();
    const ready = useKeyExchange(exchange, async (exchanged) => {
        if (!exchanged || devIdentity !== undefined)
            return;
        // A sibling observer may still be probing the cookie from before redemption.
        const filters = { queryKey: [...WHOAMI_KEY, source.endpoint ?? DEFAULT_WHOAMI_ENDPOINT], exact: true };
        await client.cancelQueries(filters);
        await client.invalidateQueries(filters);
        // Retained-login mode: the link may have joined this browser's accounts
        // (or been held as one to switch to), here and in its other tabs.
        void client.invalidateQueries({ queryKey: ACCOUNTS_KEY });
        announceSelectionChange((exchange && exchange.endpoint ? exchange.endpoint : '/api/auth/exchange').replace(/\/exchange$/, ''));
    });
    const { whoami, refresh, reason } = useWhoami(source, { enabled: ready, devIdentity, revalidateS });
    if ((!ready && devIdentity === undefined) || whoami === undefined)
        return _jsx(_Fragment, { children: loading });
    if (whoami === null)
        return (_jsx(SessionLossContext.Provider, { value: reason, children: typeof signIn === 'function' ? signIn(refresh, reason) : signIn }));
    return _jsx(_Fragment, { children: typeof children === 'function' ? children(whoami, refresh) : children });
}
