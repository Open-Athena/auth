/**
 * The two identity shapes, and the source that produces each.
 *
 * marin's `AuthGate` and watchy's `useWhoami` are the *same UX* differing only
 * in where identity comes from: the edge (`/cdn-cgi/access/get-identity`, Tier
 * 1) or the app (`/api/auth/whoami`, Tier 2). Making the source a parameter is
 * what turns a Tier-1 → Tier-2 upgrade into a one-line change.
 */
import type { Subject } from '../core/types.js';
export type WhoamiSource = {
    kind: 'edge';
    endpoint?: string;
} | {
    kind: 'app';
    endpoint?: string;
};
export declare const DEFAULT_ENDPOINTS: Record<WhoamiSource['kind'], string>;
export interface SsoWhoami {
    kind: 'sso';
    email: string;
    admin: boolean;
    scopes: string[];
}
export interface GrantWhoami {
    kind: 'grant';
    name: string | null;
    subject: Subject | null;
    email: string | null;
    scopes: string[];
    admin: false;
    expiresAt: number | null;
}
/** What `/api/auth/whoami` returns (Tier 2). */
export type AppWhoami = SsoWhoami | GrantWhoami;
/** What CF Access `get-identity` returns (Tier 1) — more fields than we use. */
export interface EdgeWhoami {
    email?: string;
    name?: string;
    user_uuid?: string;
    [key: string]: unknown;
}
export type Whoami = AppWhoami | EdgeWhoami;
/**
 * Best available human label: the grant's name, then its subject, then an email.
 *
 * `EdgeWhoami`'s index signature makes the union un-narrowable by `kind` alone
 * (every member structurally admits a `kind` field), so this reads fields off a
 * single widened view rather than pretending the discriminant works here.
 */
export declare function displayName(whoami: Whoami | null | undefined): string | null;
export declare function hasScope(whoami: Whoami | null | undefined, scope: string): boolean;
