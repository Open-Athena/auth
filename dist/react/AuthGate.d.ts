import type { ReactNode } from 'react';
import { type ExchangeOptions } from './exchange.js';
import type { Whoami, WhoamiSource } from './types.js';
export interface AuthGateProps<T extends Whoami = Whoami> {
    source: WhoamiSource;
    /** Rendered once an identity resolves. */
    children: ReactNode | ((whoami: T, refresh: () => void) => ReactNode);
    /** Rendered when nobody is signed in. */
    signIn: ReactNode | ((refresh: () => void) => ReactNode);
    /**
     * Rendered while probing. Default: nothing — the probe is one cached request,
     * and a spinner that flashes for 80ms reads worse than a blank moment.
     */
    loading?: ReactNode;
    /** Redeem a `?key=` share link before probing. Pass false to disable. */
    exchange?: ExchangeOptions | false;
}
/**
 * Probe identity, then render the app or the wall. Both tiers use this — marin
 * passes `{ kind: 'edge' }`, watchy passes `{ kind: 'app' }` — which is the
 * whole point of making the source a parameter.
 */
export declare function AuthGate<T extends Whoami = Whoami>({ source, children, signIn, loading, exchange, }: AuthGateProps<T>): import("react").JSX.Element;
