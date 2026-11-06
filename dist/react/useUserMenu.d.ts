import { type HTMLAttributes, type MouseEvent, type ReactNode } from 'react';
import { type AuthClient } from '../client/api.js';
import { type Whoami } from './types.js';
/** An app's menu entry. */
export interface UserMenuItem {
    key: string;
    label: ReactNode;
    href?: string;
    onClick?: (e: MouseEvent) => void;
    /** Rendered as is instead of a link or button, e.g. an app's own submenu. Closing the menu is then its own business. */
    content?: ReactNode;
    /** Who sees it: admins, email sign-ins (admins included), or share-link guests. Default everyone. */
    when?: 'admin' | 'sso' | 'guest';
}
/** A built-in or app entry to render. `accounts` is a place for `<AccountSwitcher>`, not a control. */
export interface UserMenuEntry {
    key: string;
    label: ReactNode;
    href?: string;
    onClick?: (e: MouseEvent) => void;
    content?: ReactNode;
}
export interface UseUserMenuOptions {
    whoami: Whoami | null | undefined;
    /** What the app knows better than the session, e.g. a registry's name or a GitHub avatar. */
    identity?: {
        name?: string | null;
        avatar?: string | null;
    };
    client: Pick<AuthClient, 'basePath' | 'logout'>;
    /** Listed after Profile, before accounts and sign out. */
    items?: readonly UserMenuItem[];
    /** Offer Profile to `sso` identities. Default true; false for a gate with no profile store. */
    profile?: boolean;
    /** Open your own profile page instead of setting `profileOpen`. */
    onOpenProfile?: () => void;
    /** After the server confirms a sign-out. The cached identity has already been dropped. */
    onSignedOut?: () => void;
    labels?: Partial<Record<'profile' | 'accounts' | 'signOut' | 'signingOut' | 'signOutFailed' | 'trigger', string>>;
}
export interface UseUserMenuResult {
    /** Null while loading or signed out: render your sign-in affordance, or nothing. */
    kind: 'sso' | 'guest' | null;
    /** Null for an anonymous share link: show a fallback, and keep the way to sign out. */
    displayName: string | null;
    avatar: string | null;
    email: string | null;
    isAdmin: boolean;
    /** Whether this gate retains several logins (its whoami carries a selection). */
    retained: boolean;
    items: readonly UserMenuEntry[];
    open: boolean;
    setOpen: (open: boolean) => void;
    profileOpen: boolean;
    closeProfile: () => void;
    signOut: () => Promise<void>;
    signingOut: boolean;
    /** The last sign-out's refusal, e.g. accounts changed in another tab. The identity has been re-read. */
    error: Error | null;
    triggerProps: HTMLAttributes<HTMLElement>;
    menuProps: HTMLAttributes<HTMLElement>;
}
/**
 * The logic of an upper-right user menu, rendering nothing: who you are, what to
 * offer them, how they sign out, and the ARIA and keyboard props. Positioning and
 * outside-click dismissal are the renderer's, which is how `/react` stays free of
 * `@floating-ui/react`; `<UserMenu>` in `/react/user-menu` adds both.
 */
export declare function useUserMenu({ whoami, identity, client, items, profile, onOpenProfile, onSignedOut, labels, }: UseUserMenuOptions): UseUserMenuResult;
