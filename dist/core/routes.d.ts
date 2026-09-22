/**
 * A mountable `/api/auth/*` surface, so a consumer wires the gate up instead of
 * re-deriving watchy's `auth.ts` by hand. Returns `null` for paths it doesn't
 * own, so an app can fall through to its own router.
 *
 * Everything here is presentation-free JSON: the wall, the admin table and the
 * copy around them are per-app and get vendored, per share-links §6.
 */
import { type DecisionPageOptions } from './decision-page.js';
import type { DecisionView } from './decisions.js';
import type { Auth } from './types.js';
import type { AllowlistStore, AuditQuery } from './store.js';
import type { Gate } from './gate.js';
import { type ResolveAvatarOptions } from './avatar.js';
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
     * Backs the `<basePath>/allowed` admin CRUD (list/add/remove allowed emails);
     * without it those routes 501. This is only the *management* surface — an app
     * still opts the table into authorization separately, by putting
     * `allowlistPolicy(store)` in its `policy`. Kept apart on purpose: mounting an
     * editor should not silently change who gets in.
     */
    allowlist?: AllowlistStore;
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
    /** Replaces the built-in approve/deny page wholesale. */
    decisionPage?: (view: DecisionView, opts: DecisionPageOptions) => Response;
    /** Shown in the approve/deny page's copy. */
    decisionAppName?: string;
    /**
     * Enables `POST <basePath>/avatar`, which resolves a Gravatar/GitHub/explicit
     * avatar for the admin UI to preview *before* minting. Only ever fetches
     * gravatar.com and github.com, so it is not a general fetch proxy.
     *
     * Off by default: it makes an outbound request per call, which a deployment
     * should opt into rather than discover.
     */
    avatarLookup?: boolean | ResolveAvatarOptions;
}
export declare function authRoutes(gate: Gate, opts?: RouteOptions): (req: Request) => Promise<Response | null>;
