import { useEffect, useRef, useState } from 'react';
import { exchangeKeyParam, hasKeyParam } from '../client/exchange.js';
export { exchangeKeyParam, hasKeyParam } from '../client/exchange.js';
/**
 * Run the exchange once on mount if a token is present. Returns whether the
 * identity probe may proceed — false only for the moment the exchange is in
 * flight, so the wall never flashes before a valid link has been redeemed.
 * An optional completion callback is awaited before the probe may proceed.
 */
export function useKeyExchange(opts = {}, onComplete) {
    const [ready, setReady] = useState(() => opts === false || !hasKeyParam(opts));
    // Belt and braces with `exchangeKeyParam`'s own idempotence: StrictMode
    // double-invokes this effect on the same instance, so a ref survives it.
    const started = useRef(false);
    useEffect(() => {
        if (ready || started.current)
            return;
        started.current = true;
        void exchangeKeyParam(opts === false ? {} : opts)
            .then(exchanged => onComplete?.(exchanged))
            .finally(() => setReady(true));
        // Mount-only by design: the token is stripped from the URL on the first run.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return ready;
}
