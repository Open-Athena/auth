/** Grants (share links / magic links) and the identities they resolve to. */
/** Optional pre-loaded identity, so a gated view can greet and watermark by name. */
export interface Subject {
    first?: string;
    last?: string;
    email?: string;
    avatar?: string;
}
export interface Grant {
    id: string;
    /** Admin-side label: "Bob Smith (donor)". */
    name: string | null;
    /** Freeform: why this link exists. */
    note: string | null;
    subject: Subject | null;
    /** If set, magic-link semantics: the grant is bound to this address. */
    email: string | null;
    scopes: string[];
    /** null = unlimited. Counts *sessions minted*, not requests. */
    maxRedeems: number | null;
    redeems: number;
    /** Epoch seconds; null = never expires. */
    expiresAt: number | null;
    /** Seconds; null = inherit the app default. */
    sessionTtlS: number | null;
    createdAt: number;
    createdBy: string;
    revokedAt: number | null;
    firstUsedAt: number | null;
    lastUsedAt: number | null;
}
export interface NewGrant {
    name?: string | null;
    note?: string | null;
    subject?: Subject | null;
    email?: string | null;
    scopes: string[];
    maxRedeems?: number | null;
    expiresAt?: number | null;
    sessionTtlS?: number | null;
    createdBy: string;
}
export type Auth = {
    kind: 'sso';
    email: string;
    admin: boolean;
    scopes: string[];
} | {
    kind: 'grant';
    grant: Grant;
    admin: false;
    scopes: string[];
};
/** Wildcard scope: granted to admins, matches every `hasScope` check. */
export declare const ALL_SCOPES = "*";
export declare function hasScope(auth: Auth, scope: string): boolean;
/** Parse the space-separated `scopes` column. Tolerates commas, since humans type them. */
export declare const parseScopes: (s: string | null | undefined) => string[];
export declare const formatScopes: (scopes: readonly string[]) => string;
