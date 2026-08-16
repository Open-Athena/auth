/**
 * A mountable `/api/auth/*` surface, so a consumer wires the gate up instead of
 * re-deriving watchy's `auth.ts` by hand. Returns `null` for paths it doesn't
 * own, so an app can fall through to its own router.
 *
 * Everything here is presentation-free JSON: the wall, the admin table and the
 * copy around them are per-app and get vendored, per share-links §6.
 */
import type { Auth } from './types.js';
import type { AuditQuery } from './store.js';
import type { Gate } from './gate.js';
export interface RouteOptions {
    /** Default `/api/auth`. */
    basePath?: string;
    /** Scope required for the admin routes. Default `admin` (the wildcard `*` satisfies it). */
    adminScope?: string;
    /**
     * Scope required to see and decide access requests. Defaults to `adminScope`.
     * Worth separating: minting a share link affects only your own links, while
     * the request queue holds other people's email addresses.
     */
    requestScope?: string;
    /** Read side of the access log; without it the activity/log routes 501. */
    audit?: AuditQuery;
    /**
     * The identity recorded as a grant's `created_by`. Default: the SSO email.
     * Returning a per-visitor value plus `scopeToCreator` gives each admin their
     * own sandbox of links — which is how the demo lets strangers try the admin
     * side without seeing (or revoking) anyone else's.
     */
    creatorOf?: (auth: Auth) => string;
    /** When set, admin reads and writes are confined to grants this identity created. */
    scopeToCreator?: (auth: Auth) => string | undefined;
    /** Hidden form field that only a bot fills in. Default `website`. */
    honeypotField?: string;
}
export declare function authRoutes(gate: Gate, opts?: RouteOptions): (req: Request) => Promise<Response | null>;
