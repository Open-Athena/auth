import type { AllowlistStore } from '../core/store.js';
export declare const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export declare const DIRECTORY_API = "https://admin.googleapis.com/admin/directory/v1";
export declare const CLOUD_IDENTITY_API = "https://cloudidentity.googleapis.com/v1";
/** Read-only scope for the Admin SDK Directory `members.list` path. */
export declare const DIRECTORY_SCOPE = "https://www.googleapis.com/auth/admin.directory.group.member.readonly";
/** Read-only scope for the Cloud Identity `memberships.list` path. */
export declare const CLOUD_IDENTITY_SCOPE = "https://www.googleapis.com/auth/cloud-identity.groups.readonly";
/** The fields of a downloaded service-account key JSON this adapter reads. */
export interface ServiceAccountKey {
    client_email: string;
    private_key: string;
    /** Defaults to `GOOGLE_TOKEN_URL`; the key file carries it too. */
    token_uri?: string;
}
export interface AccessTokenOptions {
    /** The key JSON, parsed or as the raw string a secret store hands back. */
    key: ServiceAccountKey | string;
    scopes: readonly string[];
    /**
     * Domain-wide delegation only: the admin to impersonate (the JWT `sub`).
     * Omit for a role-assigned or group-owner service account, which acts as
     * itself.
     */
    subject?: string;
    fetch?: typeof globalThis.fetch;
    nowMs?: number;
}
export interface AccessToken {
    accessToken: string;
    /** Epoch seconds. */
    expiresAt: number;
    /** The service account's `client_email` — handy for logs and `addedBy`. */
    clientEmail: string;
}
/** Which Google API lists the group. Both accept a role-assigned or owner SA. */
export type GroupsApi = 'directory' | 'cloud-identity';
export interface ListMembersOptions {
    token: string;
    /**
     * `directory` (default) flattens nested groups (`includeDerivedMembership`)
     * on every Workspace edition. `cloud-identity` lists direct members only —
     * its transitive search is Enterprise/Premium-gated.
     */
    api?: GroupsApi;
    fetch?: typeof globalThis.fetch;
}
/**
 * Mint an access token for a service account: sign a JWT-bearer assertion
 * with the key and trade it at the token endpoint. Throws on any failure —
 * every one is a provisioning error (bad key, wrong scope, no role), not a
 * state to handle at runtime.
 */
export declare function googleAccessToken({ key, scopes, subject, fetch, nowMs, }: AccessTokenOptions): Promise<AccessToken>;
/**
 * The group's active user members: lowercased, de-duplicated, sorted. Throws
 * on a non-2xx from Google (a permissions or provisioning problem).
 */
export declare function listGroupMembers(group: string, { token, api, fetch }: ListMembersOptions): Promise<string[]>;
export interface GroupSpec {
    /** The group's email address. */
    group: string;
    /** Scopes every member earns. */
    scopes: readonly string[];
}
export interface SyncOptions extends Omit<AccessTokenOptions, 'scopes'> {
    groups: readonly GroupSpec[];
    api?: GroupsApi;
}
export interface SyncResult {
    group: string;
    /** The `AllowEntry.source` the group's rows carry. */
    source: string;
    count: number;
}
/** The allowlist `source` a synced group owns: `sync:<group>`. */
export declare const syncSource: (group: string) => string;
/**
 * One token, then per group: list → `replaceSource`. Rows carry the group's
 * scopes and `addedBy: <service account email>`. A listing that throws stops
 * before that group's `replaceSource`, so a transient Google error never
 * empties a group — the previous membership stands until the next run.
 *
 * Call this from a Worker `scheduled()` handler (or any cron) with the same
 * `AllowlistStore` the app's `allowlistPolicy` reads.
 */
export declare function syncGroupsToAllowlist(store: Pick<AllowlistStore, 'replaceSource'>, { groups, api, key, subject, fetch, nowMs }: SyncOptions): Promise<SyncResult[]>;
