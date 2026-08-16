import { type Whoami, type WhoamiSource } from './types.js';
export declare const WHOAMI_KEY: readonly ["oa-auth", "whoami"];
export interface UseWhoamiOptions {
    /** Default 5 minutes. Identity rarely changes mid-session; the gate re-checks server-side anyway. */
    staleTime?: number;
    /** Hold the probe until a `?key=` exchange has finished. */
    enabled?: boolean;
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
export declare function useWhoami<T extends Whoami = Whoami>(source: WhoamiSource, { staleTime, enabled }?: UseWhoamiOptions): UseWhoamiResult<T>;
/** Drop any cached identity — call after signing out so the wall appears at once. */
export declare function useForgetWhoami(): () => void;
