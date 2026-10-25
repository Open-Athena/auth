import { type ReactNode } from 'react';
import type { AccountsResponse } from '../core/http.js';
export declare const ACCOUNTS_KEY: readonly ["oa-auth", "accounts"];
export interface UseAccountsOptions {
    /** The auth routes' base path (default `/api/auth`). */
    basePath?: string;
    enabled?: boolean;
}
export interface UseAccountsResult {
    /** undefined while loading; null when the browser holds no accounts (or the gate doesn't retain them). */
    accounts: AccountsResponse | null | undefined;
    select: (id: string | null) => Promise<void>;
    remove: (id: string) => Promise<void>;
    acceptIncoming: (id: string) => Promise<void>;
    signOut: () => Promise<void>;
    signOutAll: () => Promise<void>;
    /** A mutation in flight: disable the controls. */
    busy: boolean;
    /** The last refusal, e.g. "Your accounts changed in another tab…" (the list has already been refreshed). */
    error: Error | null;
}
/**
 * A browser's retained logins (a gate in `retained` mode): the list, and every
 * way to change it. After any change, here or in another tab, the identity
 * and the list are re-read from the server, and the private data an app keys
 * by identity should be too: watch `accounts.active` or the whoami query.
 */
export declare function useAccounts({ basePath, enabled }?: UseAccountsOptions): UseAccountsResult;
export interface AccountSwitcherProps {
    basePath?: string;
    /** Where "Add another account" goes: your sign-in page, or Google's start URL with `?account=choose`. Omit to hide it. */
    addAccountHref?: string;
    /** Called after any successful change (close a popover, say). */
    onChanged?: () => void;
    labels?: Partial<Record<'heading' | 'add' | 'signOut' | 'signOutAll' | 'remove' | 'link' | 'verified' | 'incoming' | 'useLink' | 'current', ReactNode>>;
    classNames?: Partial<Record<'root' | 'list' | 'item' | 'active' | 'switch' | 'remove' | 'tag' | 'incoming' | 'actions' | 'button' | 'error', string>>;
}
/**
 * The browser's accounts: switch with one click, add another, take one off,
 * or sign out of all. A share-link login is always labelled as one, so a
 * guest can't pass for a verified person by name and face. With a single
 * account and no incoming link it is just that account and the sign-out
 * actions: no picker to step through.
 */
export declare function AccountSwitcher({ basePath, addAccountHref, onChanged, labels, classNames }: AccountSwitcherProps): import("react").JSX.Element | null;
