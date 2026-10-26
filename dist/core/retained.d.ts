import type { AccountsResponse } from './http.js';
import type { RetainedStore } from './retained-store.js';
import type { Auth, Grant } from './types.js';
/** What an incoming share link does while another login is active. */
export type IncomingDecision = 'keep' | 'switch';
export type IncomingPolicy = IncomingDecision | ((c: {
    active: Auth;
    incoming: Grant;
    req: Request;
}) => IncomingDecision | Promise<IncomingDecision>);
export interface RetainedOptions {
    /** `d1RetainedStore(db, limits)`, on the same database as the grants. */
    store: RetainedStore;
    /** Distinguishes this gate's browser sets in a shared store (default: the gate's cookie name). */
    gateId?: string;
    /** The handle cookie (default `<gate cookie>_rs`). */
    cookieName?: string;
    /**
     * An incoming share link while a login is active: `'keep'` (the default)
     * stays as the current login and offers the link as an account to switch
     * to, spending no redemption; `'switch'` changes to it; a function decides
     * per link. With no active login, a valid link always signs in.
     */
    incoming?: IncomingPolicy;
}
/** A retained-mode refusal the routes answer with 409. */
export declare class RetainedLoginError extends Error {
    readonly code: 'retained-login-capacity' | 'pending-link-capacity' | 'selection_context_conflict'
    /** A held link that can't become a login now: the browser is full, the link used up, or the offer lapsed. */
     | 'incoming-unavailable';
    constructor(code: 'retained-login-capacity' | 'pending-link-capacity' | 'selection_context_conflict'
    /** A held link that can't become a login now: the browser is full, the link used up, or the offer lapsed. */
     | 'incoming-unavailable');
}
/** The gate's side of a retained login: turn a principal into a live identity (or not). */
export type ResolveSub = (req: Request, claims: {
    sub: string;
    iat: number;
}, nowS: number, opts: {
    quiet: boolean;
    logView: boolean;
}) => Promise<{
    auth: Auth | null;
    reason: import('./denial.js').SessionLossReason | null;
}>;
interface Deps {
    secret: string;
    gateCookie: string;
    sessionTtlS: number;
    resolve: ResolveSub;
    grantById: (id: string) => Promise<Grant | null>;
}
export declare function retainedMode(opts: RetainedOptions, deps: Deps): {
    handleCookie: string;
    clearHandle: (req: Request) => string;
    /**
     * The active login's identity when this request carries a handle; `'absent'`
     * when it carries none (the caller then reads a single-session cookie, so a
     * browser from before retention keeps working until its next sign-in).
     */
    authenticate(req: Request, nowMs: number, logView: boolean): Promise<"absent" | {
        auth: Auth | null;
        reason: import("./denial.js").SessionLossReason | null;
        issuedAt: number | null;
    }>;
    /** The serialized selection context for this request's set, or null without one. */
    selection(req: Request, nowMs: number): Promise<string | null>;
    /** An IdP or emailed code vouched for `email`: add that login and make it the active one. */
    signIn(req: Request, email: string, nowMs: number): Promise<string[]>;
    /**
     * An incoming share link (already found valid and redeemable by the gate).
     * With no usable active login it signs in (one redemption, or none if this
     * browser already holds that link's session). With one, `incoming` decides:
     * keep the current login and hold the link as an account to switch to, or
     * switch now.
     */
    incoming(req: Request, grant: Grant, tokenHash: string, nowMs: number): Promise<{
        ok: true;
        switched: true;
        minted: boolean;
        cookies: string[];
        selection: string;
    }
    /** `pendingId` null: the link is the active login already. */
     | {
        ok: true;
        switched: false;
        active: Auth;
        pendingId: string | null;
        cookies: string[];
        selection: string;
    } | {
        ok: false;
        cookies: string[];
    }>;
    /** The logins this browser holds, its active one, and any incoming links waiting on a choice. */
    accounts(req: Request, nowMs: number): Promise<AccountsResponse | null>;
    /** Switch to one of this browser's logins (or to none). Never extends its evidence. */
    select(req: Request, sessionId: string | null, nowMs: number): Promise<AccountsResponse | null>;
    /** Take one login off this browser. Removing the active one leaves it signed out: nothing else is selected. */
    remove(req: Request, sessionId: string, nowMs: number): Promise<AccountsResponse | null>;
    /** Choose a held incoming link: it becomes a login (spending a redemption only if it's new here) and the active one. */
    acceptIncoming(req: Request, pendingId: string, nowMs: number): Promise<AccountsResponse | null>;
    /**
     * Sign out of the active login only: it's removed from this browser, and
     * the others stay. A stale selection header is refused. No header at all
     * is what a client from before retained mode sends; it signs out whichever
     * login is active now, since a sign-out can only ever take access away.
     */
    signOut(req: Request, nowMs: number): Promise<string[]>;
    /** Sign this browser out of every login it holds; the handle is cleared. Other browsers are untouched. */
    signOutAll(req: Request, nowMs: number): Promise<string[]>;
    /**
     * For an app's own cookie-authenticated mutations: refuse one sent under a
     * selection the browser has since left (another tab switched accounts),
     * before any side effect. Null = go ahead. Bearer requests and requests
     * without a handle aren't subject to it.
     */
    checkMutation(req: Request, nowMs: number): Promise<Response | null>;
};
export declare const selectionConflict: () => Response;
export type RetainedMode = ReturnType<typeof retainedMode>;
export {};
