import { useEffect, useRef, useState } from 'react';
export const hasKeyParam = ({ param = 'key' } = {}) => typeof window !== 'undefined' && new URL(window.location.href).searchParams.has(param);
/**
 * Trade a `?key=<token>` share link for a session cookie.
 *
 * The token is claimed — read *and* stripped from the URL — synchronously,
 * before the network call. Two reasons, both learned the hard way:
 *
 *  - A token left in the URL survives in history, in the back button, and in
 *    whatever the recipient copy-pastes onward. It goes as early as possible,
 *    and it goes whether or not the exchange succeeds.
 *  - Stripping first makes this function self-idempotent. A second concurrent
 *    call (React StrictMode double-invokes effects; so does any remount) finds
 *    no token and does nothing, instead of spending a second redemption.
 *    Redemptions are the forwarding signal — double-counting them makes the
 *    admin view lie about how widely a link travelled.
 */
export async function exchangeKeyParam(opts = {}) {
    const { param = 'key', endpoint = '/api/auth/exchange' } = opts;
    if (typeof window === 'undefined')
        return false;
    const url = new URL(window.location.href);
    const token = url.searchParams.get(param);
    if (!token)
        return false;
    url.searchParams.delete(param);
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
    try {
        const res = await fetch(endpoint, {
            method: 'POST',
            credentials: 'include',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ token }),
        });
        return res.ok;
    }
    catch {
        return false;
    }
}
/**
 * Run the exchange once on mount if a token is present. Returns whether the
 * identity probe may proceed — false only for the moment the exchange is in
 * flight, so the wall never flashes before a valid link has been redeemed.
 */
export function useKeyExchange(opts = {}) {
    const [ready, setReady] = useState(() => opts === false || !hasKeyParam(opts));
    // Belt and braces with `exchangeKeyParam`'s own idempotence: StrictMode
    // double-invokes this effect on the same instance, so a ref survives it.
    const started = useRef(false);
    useEffect(() => {
        if (ready || started.current)
            return;
        started.current = true;
        void exchangeKeyParam(opts === false ? {} : opts).finally(() => setReady(true));
        // Mount-only by design: the token is stripped from the URL on the first run.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return ready;
}
