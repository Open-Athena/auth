import { type Whoami, type WhoamiSource } from './types.js';
export declare const WHOAMI_KEY: readonly ["oa-auth", "whoami"];
export interface UseWhoamiOptions<T> {
    /** Default 5 minutes. Identity rarely changes mid-session; the gate re-checks server-side anyway. */
    staleTime?: number;
    /** Hold the probe until a `?key=` exchange has finished. */
    enabled?: boolean;
    /**
     * Skip the probe and use this identity instead. For local development against
     * a Tier-1 (edge) source, where `/cdn-cgi/access/get-identity` doesn't exist
     * and every page would otherwise show the wall.
     *
     * The *policy* stays in the app, which is the only place that knows its own
     * build flags:
     *
     * ```ts
     * devIdentity: import.meta.env.DEV && !forceWall ? { email: 'dev@example.test' } : undefined
     * ```
     *
     * `undefined` probes normally; `null` forces the signed-out state (handy for
     * eyeballing the wall without a deploy). It can only ever loosen the *client*
     * — the server gate is unaffected, so this can't grant real access.
     */
    devIdentity?: T | null;
}
export interface UseWhoamiResult<T> {
    /** `undefined` while loading, `null` when signed out, else the identity. */
    whoami: T | null | undefined;
    refresh: () => void;
    error: Error | null;
}
/**
 * Probe the current identity from either source. `retry: false` because a 401
 * is a real answer, not a transient failure — retrying it just delays the wall.
 */
export declare function useWhoami<T extends Whoami = Whoami>(source: WhoamiSource, { staleTime, enabled, devIdentity }?: UseWhoamiOptions<T>): UseWhoamiResult<T>;
/** Drop any cached identity — call after signing out so the wall appears at once. */
export declare function useForgetWhoami(): () => void;
