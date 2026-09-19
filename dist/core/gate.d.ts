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
import { type AssetStore } from './assets.js';
import { type Profile } from './profile.js';
import { type EmailPolicy } from './policy.js';
import { type AccessRequest, type Notify, type RateLimit } from './requests.js';
import type { GrantListOpts, GrantStore, ProfileStore, RequestListOpts, RequestStore } from './store.js';
import { type DecisionLinkOptions, type DecisionView } from './decisions.js';
import { ALL_SCOPES, type Auth, type Grant, type GrantPatch, type NewGrant, type Subject } from './types.js';
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
    /**
     * Enables approve/deny links in the `access-requested` notification, so an
     * admin can decide from their mail client. Absent = feature off.
     */
    decisionLinks?: DecisionLinkOptions;
    /** Shape of the grant minted when a request is approved. */
    approvalGrant?: {
        scopes?: string[];
        expiresInS?: number | null;
        maxRedeems?: number | null;
        sessionTtlS?: number | null;
    };
    /**
     * Self-set profiles (name + avatar). Without it, `getProfile`/`putProfile`
     * report unconfigured and every SSO `subject` is null (initials, as today).
     */
    profiles?: ProfileStore;
    /**
     * Where uploaded avatar bytes live when too big to inline. Without it,
     * avatars inline as `data:` URIs capped at `MAX_INLINE_AVATAR_BYTES`.
     */
    assets?: AssetStore;
    /**
     * Let a share-link (grant) session edit its own profile. Default false: a
     * link's face is the admin's anti-forwarding signal, and a *forwarded* link
     * rewriting whose identity it shows is exactly the hazard to avoid. Even when
     * true, only an email-bound grant qualifies — an anonymous link has no
     * principal to key a profile by.
     */
    allowGrantSelfEdit?: boolean;
    /**
     * Reject a profile edit within this many seconds of the last one — a durable,
     * per-principal throttle (the row's `updatedAt`), no counter store needed.
     * Default 0 (off).
     */
    profileMinEditIntervalS?: number;
    /**
     * Byte cap for an *uploaded* avatar when an `AssetStore` is bound (larger
     * faces live out of the row). Default 256 KB. Inlined sources (url/github/
     * gravatar, and uploads with no asset store) stay capped at
     * `MAX_INLINE_AVATAR_BYTES`.
     */
    profileUploadMaxBytes?: number;
    /** Injectable fetch for server-side avatar copying (url/github/gravatar). Default global. */
    fetch?: typeof globalThis.fetch;
}
export type RedeemFailure = 'bad-token' | 'revoked' | 'disabled' | 'expired' | 'exhausted';
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
/**
 * How a caller supplies an avatar to `putProfile`. Every source is copied
 * server-side (`resolveAvatar`/`validateUploadedImage`) — a live remote URL is
 * never persisted. `null` clears the avatar; `undefined` leaves it unchanged.
 */
export type AvatarInput = {
    upload: Uint8Array;
} | {
    url: string;
} | {
    github: string;
} | {
    gravatar: true;
} | null | undefined;
export interface ProfileInput {
    first?: string | null;
    last?: string | null;
    avatar?: AvatarInput;
}
export type PutProfileResult = {
    ok: true;
    profile: Profile;
}
/** No profile store bound. */
 | {
    ok: false;
    reason: 'unconfigured';
}
/** A bare/grant session that may not self-edit. */
 | {
    ok: false;
    reason: 'forbidden';
}
/** Edited again within `profileMinEditIntervalS`. */
 | {
    ok: false;
    reason: 'rate-limited';
}
/** The supplied avatar bytes/url/handle were not an acceptable image. */
 | {
    ok: false;
    reason: 'invalid-avatar';
    detail: string;
};
/**
 * Two different questions, deliberately separated (see migration 0007).
 *
 * `canRedeem` — may this link mint a *new* session? Blocked by revoke, by
 * disable, and by expiry. (Redemption caps are checked in SQL, at redeem time,
 * so two concurrent opens can't both pass a `maxRedeems: 1` check.)
 *
 * `sessionValid` — may a session already minted from this link keep working?
 * Blocked by revoke always, and by expiry only when the link says so. Disabling
 * never touches it: "stop handing this out" is not "throw everyone out".
 */
export declare function canRedeem(grant: Grant, nowS: number): boolean;
export declare function sessionValid(grant: Grant, nowS: number): boolean;
/**
 * @deprecated Ambiguous now that redemption and session validity can differ —
 * it answers the `canRedeem` question. Kept so an adopter's import doesn't
 * break mid-upgrade.
 */
export declare const isActive: typeof canRedeem;
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
    disable: (id: string, nowMs?: number) => Promise<boolean>;
    enable: (id: string, nowMs?: number) => Promise<boolean>;
    update: (id: string, patch: GrantPatch, nowMs?: number) => Promise<Grant | null>;
    logView: (req: Request, auth: Auth, nowS?: number, path?: string) => Promise<void>;
    whoami: (auth: Auth) => {
        kind: "sso";
        email: string;
        admin: boolean;
        scopes: string[];
        subject: Subject | null;
        id?: undefined;
        name?: undefined;
        expiresAt?: undefined;
    } | {
        kind: "grant";
        id: string;
        name: string | null;
        subject: Subject | null;
        email: string | null;
        scopes: string[];
        admin: boolean;
        expiresAt: number | null;
    };
    getProfile: (auth: Auth) => Promise<Profile | null>;
    putProfile: (auth: Auth, input: ProfileInput, nowMs?: number) => Promise<PutProfileResult>;
    isAdmin: (email: string) => boolean;
    cookieName: string;
    /**
     * The HMAC key, for adapters that need to sign something alongside a
     * session — the OIDC adapter's `state`, say. Not a widening of exposure:
     * anyone holding this object can already `signIn` as any address.
     */
    secret: string;
    requestAccess: (input: {
        email: string;
        name?: string | null;
        note?: string | null;
        subject?: Subject | null;
    }, req: Request, nowMs?: number) => Promise<RequestAccessResult>;
    approveRequest: (id: string, approvedBy: string, override?: {
        scopes?: string[];
    }, nowMs?: number) => Promise<{
        request: AccessRequest;
        grant: Grant;
        token: string;
    } | null>;
    denyRequest: (id: string, deniedBy: string, nowMs?: number) => Promise<AccessRequest | null>;
    decide: (token: string, o?: {
        commit?: boolean;
        actor?: string | null;
        nowMs?: number;
    }) => Promise<DecisionView>;
    list: (o?: GrantListOpts) => Promise<Grant[]>;
    listRequests: (o?: RequestListOpts) => Promise<AccessRequest[]>;
};
export type Gate = ReturnType<typeof createGate>;
export { ALL_SCOPES };
