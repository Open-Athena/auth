/** The two identity shapes a gate's `/whoami` returns, and where to ask for them. */
import type { Subject } from '../core/types.js';
/** Where a gate's `/whoami` is mounted. */
export interface WhoamiSource {
    endpoint?: string;
}
export declare const DEFAULT_WHOAMI_ENDPOINT = "/api/auth/whoami";
export interface SsoWhoami {
    kind: 'sso';
    email: string;
    admin: boolean;
    scopes: string[];
    /** The principal's self-set profile, or null (initials). Carried so `<Avatar>`/`displayName` render staff faces without a render-side change. */
    subject: Subject | null;
    /** Retained-login mode only: the browser's selection context, sent back as `X-OA-Selection-Context` on mutations. */
    selection?: string;
}
export interface GrantWhoami {
    kind: 'grant';
    /** The grant's id — the session's subject is `g:<id>`. Not a secret. */
    id: string;
    subject: Subject | null;
    email: string | null;
    scopes: string[];
    admin: false;
    expiresAt: number | null;
    /** An anonymous link: `subject` and `email` are withheld from the holder. `pseudonym(id)` gives it a stable name. */
    anon?: true;
    /** Retained-login mode only: see `SsoWhoami.selection`. */
    selection?: string;
}
/** What a gate's `/whoami` returns: an email session, or a share-link session. */
export type Whoami = SsoWhoami | GrantWhoami;
/**
 * A stable "Anonymous Capybara"-style name for an anonymous link, derived from
 * its grant id: every session of one link gets the same name, and nothing is stored.
 */
export declare function pseudonym(grantId: string): string;
/**
 * Best available human label: the *person*, then an email, or null for an
 * anonymous link (unnamed, or `anon`; see `pseudonym` for the latter). A link's
 * memo is not a candidate: it's the minter's note, and a gate doesn't send it to the link session.
 */
export declare function displayName(whoami: Whoami | null | undefined): string | null;
export declare function hasScope(whoami: Whoami | null | undefined, scope: string): boolean;
