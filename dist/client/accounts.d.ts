/**
 * Retained logins from the browser: list this browser's accounts, switch,
 * remove one, take up an incoming share link, sign out of one or all. Every
 * change sends the selection the page last saw (`X-OA-Selection-Context`), so
 * a page still showing account A can't act as B after another tab switched:
 * the server answers 409, and the page refreshes and asks again.
 *
 * Tabs hear about each other's changes through a `BroadcastChannel` per auth
 * base path. A notice carries nothing but "look again": every tab re-reads the
 * server's truth.
 */
import type { AccountsResponse } from '../core/http.js';
export declare const SELECTION_HEADER = "X-OA-Selection-Context";
export interface AccountsClientOptions {
    /** The auth routes' base path (default `/api/auth`). */
    basePath?: string;
    fetch?: typeof globalThis.fetch;
}
/** A 409 meaning "the browser's accounts changed since this page looked": refresh, then let the person retry. */
export declare class SelectionConflictError extends Error {
    constructor();
}
/** Any other refusal, with the server's error code (`retained-login-capacity`, `incoming-unavailable`, …). */
export declare class AccountsError extends Error {
    readonly status: number;
    readonly code: string | null;
    constructor(status: number, code: string | null);
}
/** Tell this browser's other tabs that the selection changed. A no-op where `BroadcastChannel` doesn't exist. */
export declare function announceSelectionChange(basePath?: string): void;
/** Run `listener` when another tab changes this browser's selection. Returns the unsubscribe. */
export declare function onSelectionChange(listener: () => void, basePath?: string): () => void;
export declare function createAccountsClient({ basePath, fetch }?: AccountsClientOptions): {
    /** This browser's accounts, or null when it holds none (or the gate isn't in retained mode). */
    list(): Promise<AccountsResponse | null>;
    /** Switch to one of this browser's accounts (`null`: to none, keeping them all). */
    select: (id: string | null, selection: string | null) => Promise<AccountsResponse>;
    /** Take an account off this browser (not the link, not other browsers). */
    remove: (id: string, selection: string | null) => Promise<AccountsResponse>;
    /** Use an incoming share link that was held while another account was active. */
    acceptIncoming: (id: string, selection: string | null) => Promise<AccountsResponse>;
    /** Sign out of the active account only; the browser keeps the others. */
    logout: (selection: string | null) => Promise<unknown>;
    /** Sign this browser out of every account. */
    logoutAll: () => Promise<unknown>;
};
export type AccountsClient = ReturnType<typeof createAccountsClient>;
