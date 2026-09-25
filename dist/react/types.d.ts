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
}
export interface GrantWhoami {
    kind: 'grant';
    /** The grant's id — the session's subject is `g:<id>`. Not a secret. */
    id: string;
    name: string | null;
    subject: Subject | null;
    email: string | null;
    scopes: string[];
    admin: false;
    expiresAt: number | null;
}
/** What a gate's `/whoami` returns: an email session, or a share-link session. */
export type Whoami = SsoWhoami | GrantWhoami;
/**
 * Best available human label: the *person* first, then the link's memo, then an
 * email.
 *
 * Subject before name, because they answer different questions. `name` is an
 * admin's memo — "Q3 board packet", "test-1756800000" — written for the table
 * it appears in, while `subject` is who the link was minted *for*. Preferring
 * the memo meant a link with both rendered "Private link for Q3 board packet",
 * which is the wrong noun in the wrong sentence.
 */
export declare function displayName(whoami: Whoami | null | undefined): string | null;
export declare function hasScope(whoami: Whoami | null | undefined, scope: string): boolean;
