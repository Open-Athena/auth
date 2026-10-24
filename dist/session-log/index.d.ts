/**
 * `@open-athena/auth/session-log`: optional, time-boxed user-action logging
 * for reproducing a reported bug. Off by default; an admin switches it on for
 * a few days (at most 31, or explicitly with no end date) and reads each
 * session's event timeline. The D1 store is `@open-athena/auth/session-log/d1`
 * (migration `migrations/session-log/`), the browser logger
 * `@open-athena/auth/session-log/client`, the admin UI
 * `@open-athena/auth/react/session-log`.
 */
import type { Gate } from '../core/gate.js';
import type { SessionLogWho } from './store.js';
export * from '../core/session-log-shape.js';
export * from './store.js';
export { sessionLogRoutes, type SessionLogCtx, type SessionLogRoutesOptions } from './routes.js';
export interface FromGateOptions {
    /** The scope that may read sessions and flip the switch (default `'admin'`). */
    adminScope?: string;
    /**
     * Log visitors with no session too (a public site), as `{email: null, via: 'public'}`.
     * Off by default: only signed-in viewers are logged.
     */
    anonymous?: boolean;
}
/**
 * `identify` and `requireAdmin` from an `@open-athena/auth` gate. A link
 * session is logged under its bound address when it has one (`via: 'grant'`),
 * else with no address; an SSO session under its email (`via: 'sso'`).
 */
export declare function fromGate(gate: Gate, opts?: FromGateOptions): {
    identify(req: Request): Promise<SessionLogWho | null>;
    requireAdmin(req: Request): Promise<{
        who: string;
    } | Response>;
};
