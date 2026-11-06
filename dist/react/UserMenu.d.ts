import { type ReactNode } from 'react';
import type { AuthClient } from '../client/api.js';
import { type AccountSwitcherProps } from './Accounts.js';
import { type ProfilePanelProps } from './ProfilePanel.js';
import { type UseUserMenuOptions } from './useUserMenu.js';
import type { Whoami } from './types.js';
export interface UserMenuProps extends Omit<UseUserMenuOptions, 'client' | 'whoami'> {
    whoami: Whoami | null | undefined;
    client: AuthClient;
    /** Rendered when signed out, e.g. a sign-in link. Default nothing. */
    signedOut?: ReactNode;
    /** Where "Add another account" goes in a retained gate's account list. */
    addAccountHref?: string;
    /** Name for an anonymous share link, whose trigger shows `?`. */
    anonymousLabel?: ReactNode;
    guestLabel?: ReactNode;
    backLabel?: ReactNode;
    /** Trigger face size, in pixels. */
    size?: number;
    accountSwitcher?: Pick<AccountSwitcherProps, 'labels' | 'classNames'>;
    profilePanel?: Pick<ProfilePanelProps, 'labels' | 'classNames'>;
    classNames?: Partial<Record<'trigger' | 'popover' | 'identity' | 'name' | 'email' | 'tag' | 'menu' | 'item' | 'back' | 'error', string>>;
}
/**
 * The upper-right menu: an avatar opening who you are, Profile, the app's own
 * entries, retained accounts, and sign out. Built only on `useUserMenu`, so an
 * app can restyle this or write its own. A share link is always labelled as one,
 * so a guest can't pass for a verified person by name and face.
 */
export declare function UserMenu({ whoami, client, signedOut, addAccountHref, anonymousLabel, guestLabel, backLabel, size, accountSwitcher, profilePanel, classNames, ...options }: UserMenuProps): import("react").JSX.Element | null;
