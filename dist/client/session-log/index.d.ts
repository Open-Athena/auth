/**
 * `@open-athena/auth/session-log/client`: the session log's boot shim, the only
 * part an app loads up front. `bootSessionLog` asks the endpoint whether this
 * tab logs right now; if so it imports the logger chunk (`./logger.js`) and
 * hands it the events raised meanwhile. Off (the default), it is one request
 * per page load and nothing else. Importing this module installs nothing: no
 * listener exists until `bootSessionLog` runs.
 *
 * `slog` is the app's hook for events the page can't see on its own: an app
 * event declared on the server (`appEvents`), or a built-in kind such as
 * `pick` from a custom picker.
 */
import type { Kind, SessionLogConfig } from '../../core/session-log-shape.js';
export type * from '../../core/session-log-shape.js';
type Fields = Record<string, unknown>;
/** Record an event (a no-op while off; held briefly while the boot decides). */
export declare function slog(k: Kind, f?: Fields): void;
export interface BootOptions {
    /** The app's build id (a git SHA, say), recorded on every batch. */
    build: string;
    /** Default `/api/session-log`. */
    endpoint?: string;
    /** More URL params to mask, besides the built-in secret ones. */
    secretParams?: readonly string[];
}
/** Whether a config answer means "log this tab now". */
export declare const shouldLog: (cfg: Partial<SessionLogConfig> | null, now?: number) => cfg is SessionLogConfig & {
    until: number;
};
/**
 * Decide, then start or stand down. Never throws and never delays the app:
 * call it without awaiting, once, at startup. Resolves to whether it started.
 */
export declare function bootSessionLog(o: BootOptions): Promise<boolean>;
/** Forget the boot (tests): back to idle, nothing held. */
export declare function resetSessionLog(): void;
