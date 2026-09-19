/**
 * The store interface `core` depends on. Adapters (see `src/adapters/d1.ts`)
 * are pure row I/O: they map columns to `Grant` and back, and implement exactly
 * one piece of logic — the atomic `redeem` compare-and-swap, which has to live
 * in SQL to be race-free. Every other rule (expiry, revocation, scopes) stays
 * in core so there is one copy of it per rule, not one per backend.
 */
import type { PendingAuth } from './email-codes.js';
import type { Profile } from './profile.js';
import type { AccessRequest, RequestStatus } from './requests.js';
import type { Grant, GrantPatch, NewGrant } from './types.js';
export interface GrantListOpts {
    includeRevoked?: boolean;
    /** Default true, matching `includeRevoked`: a disabled link is still history. */
    includeDisabled?: boolean;
    /**
     * Only grants minted by this identity. Multi-tenant apps (and the demo's
     * per-visitor sandbox) use it to keep one admin out of another's links.
     */
    createdBy?: string;
}
export interface GrantStore {
    byId(id: string): Promise<Grant | null>;
    byTokenHash(tokenHash: string): Promise<Grant | null>;
    insert(grant: Grant, tokenHash: string): Promise<void>;
    /**
     * Atomically claim one redemption: increment `redeems` and stamp
     * `first_used_at`/`last_used_at`, but only if the grant is still unrevoked,
     * unexpired, and under `max_redeems`. Returns the updated grant, or null if
     * the guard failed. Must be a single statement — a read-then-write here would
     * let two concurrent opens both pass a `max_redeems: 1` check.
     */
    redeem(id: string, nowS: number): Promise<Grant | null>;
    /**
     * Best-effort "last seen" stamp on a request that reused an existing session.
     * May skip the write if the grant was already touched within `minIntervalS`,
     * so a chatty SPA doesn't turn every fetch into a DB write.
     */
    touch(id: string, nowS: number, minIntervalS: number): Promise<void>;
    /** Returns false if the grant was already revoked or does not exist. */
    revoke(id: string, nowS: number): Promise<boolean>;
    /**
     * Set or clear `disabled_at`. Returns false if the grant doesn't exist or is
     * revoked — revocation is final, so re-enabling past it must not be possible.
     */
    setDisabled(id: string, nowS: number | null): Promise<boolean>;
    /** Apply a patch; returns the updated grant, or null if there is no such grant. */
    update(id: string, patch: GrantPatch): Promise<Grant | null>;
    list(opts?: GrantListOpts): Promise<Grant[]>;
}
export interface RequestListOpts {
    status?: RequestStatus;
    limit?: number;
}
export interface RequestStore {
    byId(id: string): Promise<AccessRequest | null>;
    /** The open request for this address, if any — so a re-visit doesn't pile up duplicates. */
    pendingByEmail(email: string): Promise<AccessRequest | null>;
    insert(request: AccessRequest, ipHash: string | null): Promise<void>;
    /** Records the decision; returns null if the row was already decided by someone else. */
    decide(id: string, decision: {
        status: RequestStatus;
        decidedBy: string;
        grantId: string | null;
        nowS: number;
    }): Promise<AccessRequest | null>;
    /**
     * Overwrite an existing decision, guarded on the status it is replacing.
     *
     * Separate from `decide` because that one is guarded on `status = 'pending'`
     * — the property that keeps two admins clicking approve at once from minting
     * two grants. Reversal needs the same compare-and-swap against a *decided*
     * row, so it gets its own method rather than loosening that guard.
     */
    reverse(id: string, decision: {
        from: RequestStatus;
        status: RequestStatus;
        decidedBy: string;
        grantId: string | null;
        nowS: number;
    }): Promise<AccessRequest | null>;
    list(opts?: RequestListOpts): Promise<AccessRequest[]>;
    /** Rate-limit support: requests from this email or IP since `sinceS`. */
    countSince(sinceS: number, by: {
        email?: string;
        ipHash?: string | null;
    }): Promise<number>;
}
/**
 * Self-set profiles, keyed by the principal's verified email. Pure row I/O:
 * the gate resolves the avatar (to a `data:` URI or `asset://` ref) and cleans
 * the name before handing a finished `Profile` to `put`, so a backend never has
 * to know how an avatar was sourced.
 */
export interface ProfileStore {
    get(email: string): Promise<Profile | null>;
    /** Upsert the row for `profile.email`. */
    put(profile: Profile): Promise<void>;
    del(email: string): Promise<void>;
}
/**
 * Pending email-code sign-ins (`core/email-codes.ts`). Pure row I/O; the flow
 * logic — hashing, expiry, attempt caps, single-use — lives in core, so a
 * backend implements only storage and the one atomic `consume`.
 */
export interface PendingAuthStore {
    insert(row: PendingAuth): Promise<void>;
    byId(id: string): Promise<PendingAuth | null>;
    byTokenHash(tokenHash: string): Promise<PendingAuth | null>;
    /**
     * Atomically stamp `consumed_at` iff it is still null. Returns the row when
     * this call won the claim, else null — the single-use guarantee, in SQL, so a
     * clicked link and a typed code can't both mint a session.
     */
    consume(id: string, nowS: number): Promise<PendingAuth | null>;
    /** Increment the wrong-guess counter; returns the new count. */
    bumpAttempts(id: string): Promise<number>;
    /** Rate-limit support: rows created for this address at or after `sinceS`. */
    countSince(email: string, sinceS: number): Promise<number>;
}
/** What an admin view needs to answer "what happened to Bob's link?". */
export interface GrantActivity {
    grantId: string;
    /** Distinct `ip_hash` values seen — the forwarding signal, per share-links §3. */
    distinctIps: number;
    countries: string[];
    views: number;
    firstSeen: number | null;
    lastSeen: number | null;
    topPaths: {
        path: string;
        views: number;
    }[];
}
export interface AuditQuery {
    activity(grantId: string): Promise<GrantActivity>;
    /** Most recent events, newest first. `grantId` narrows to one link's trail. */
    recent(opts?: {
        grantId?: string;
        createdBy?: string;
        limit?: number;
    }): Promise<StoredEvent[]>;
}
/** An `access_log` row as read back out. */
export interface StoredEvent {
    id: number;
    ts: number;
    event: string;
    grantId: string | null;
    sessionSub: string | null;
    path: string | null;
    reason: string | null;
    country: string | null;
}
/** Convenience: what a store needs from `mintGrant` before it has an id/timestamps. */
export type GrantDraft = NewGrant;
