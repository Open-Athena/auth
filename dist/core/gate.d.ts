/**
 * The gate: sessions and grants as peers.
 *
 * An SSO sign-in and a share link both end at the same first-party session
 * cookie; the only difference is the `sub` it carries. Grant-backed sessions
 * re-join their grant row on *every* request, so revoking a link kills every
 * session it ever minted, instantly — that property is what makes the social
 * story (assume forwarding; make it visible and revocable) actually work.
 */
import { type AuditSink } from './audit.js';
import { type EmailPolicy } from './policy.js';
import { type AccessRequest, type Notify, type RateLimit } from './requests.js';
import type { GrantListOpts, GrantStore, RequestListOpts, RequestStore } from './store.js';
import { ALL_SCOPES, type Auth, type Grant, type NewGrant } from './types.js';
export interface GateOptions {
    store: GrantStore;
    /** HMAC key for session cookies and IP hashing. */
    secret: string;
    /** Which SSO identities are allowed, and what scopes they get. Default: admins only. */
    policy?: EmailPolicy;
    /** Always allowed, always `*`. Checked ahead of `policy`. */
    adminEmails?: readonly string[];
    cookieName?: string;
    sessionTtlS?: number;
    audit?: AuditSink;
    /** Skip redundant `last_used_at` writes within this window. Default 60s. */
    touchIntervalS?: number;
    /**
     * Log a `view` event per authenticated request (deduped per session/path/hour).
     * Off by default: the privacy-forward default, to be turned on alongside the
     * "access is logged" disclosure copy rather than silently.
     */
    logViews?: boolean;
    /**
     * Drop `view` rows from self-identified automation. Default true. Only views
     * are filtered — an auth-lifecycle event from a bot is exactly the thing you
     * want to see in the log.
     */
    filterBots?: boolean;
    /** Enables the request-access flow. Without it, `requestAccess` throws. */
    requests?: RequestStore;
    /** Where approvals and notifications go. Default: nowhere. */
    notify?: Notify;
    rateLimit?: RateLimit;
    /** Shape of the grant minted when a request is approved. */
    approvalGrant?: {
        scopes?: string[];
        expiresInS?: number | null;
        maxRedeems?: number | null;
        sessionTtlS?: number | null;
    };
}
export type RedeemFailure = 'bad-token' | 'revoked' | 'expired' | 'exhausted';
export type RequestAccessResult = 
/** Policy matched: a grant was minted and handed to `notify` immediately. */
{
    status: 'auto';
    request: AccessRequest;
    grant: Grant;
    token: string;
}
/** Waiting on an admin. Also returned for a re-submit, with the original row. */
 | {
    status: 'pending';
    request: AccessRequest;
} | {
    status: 'invalid';
} | {
    status: 'rate-limited';
};
export type RedeemResult = {
    ok: true;
    grant: Grant;
    auth: Auth;
    cookie: string;
} | {
    ok: false;
    reason: RedeemFailure;
};
export interface MintResult {
    grant: Grant;
    /** The raw token. Returned exactly once — only its hash is stored. */
    token: string;
}
/** Active = not revoked, not expired. Redemption caps are checked only at redeem time. */
export declare function isActive(grant: Grant, nowS: number): boolean;
export declare function createGate(opts: GateOptions): {
    authenticate: (req: Request, nowMs?: number, { logView: shouldLogView }?: {
        logView?: boolean;
    }) => Promise<Auth | null>;
    redeem: (token: string, req: Request, nowMs?: number) => Promise<RedeemResult>;
    signIn: (email: string, req: Request, nowMs?: number) => Promise<{
        auth: Auth;
        cookie: string;
    } | null>;
    signOut: (req: Request, auth?: Auth | null, nowMs?: number) => Promise<string>;
    mint: (draft: NewGrant, nowMs?: number) => Promise<MintResult>;
    revoke: (id: string, nowMs?: number) => Promise<boolean>;
    logView: (req: Request, auth: Auth, nowS?: number, path?: string) => Promise<void>;
    whoami: (auth: Auth) => {
        kind: "sso";
        email: string;
        admin: boolean;
        scopes: string[];
        name?: undefined;
        subject?: undefined;
        expiresAt?: undefined;
    } | {
        kind: "grant";
        name: string | null;
        subject: import("./types.js").Subject | null;
        email: string | null;
        scopes: string[];
        admin: boolean;
        expiresAt: number | null;
    };
    isAdmin: (email: string) => boolean;
    cookieName: string;
    requestAccess: (input: {
        email: string;
        name?: string | null;
        note?: string | null;
    }, req: Request, nowMs?: number) => Promise<RequestAccessResult>;
    approveRequest: (id: string, approvedBy: string, override?: {
        scopes?: string[];
    }, nowMs?: number) => Promise<{
        request: AccessRequest;
        grant: Grant;
        token: string;
    } | null>;
    denyRequest: (id: string, deniedBy: string, nowMs?: number) => Promise<AccessRequest | null>;
    list: (o?: GrantListOpts) => Promise<Grant[]>;
    listRequests: (o?: RequestListOpts) => Promise<AccessRequest[]>;
};
export type Gate = ReturnType<typeof createGate>;
export { ALL_SCOPES };
