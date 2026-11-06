import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { AuthClientError } from '../client/api.js';
import { announceSelectionChange, SelectionConflictError } from '../client/accounts.js';
import { displayName } from './types.js';
import { useForgetWhoami, WHOAMI_KEY } from './useWhoami.js';
/**
 * The logic of an upper-right user menu, rendering nothing: who you are, what to
 * offer them, how they sign out, and the ARIA and keyboard props. Positioning and
 * outside-click dismissal are the renderer's, which is how `/react` stays free of
 * `@floating-ui/react`; `<UserMenu>` in `/react/user-menu` adds both.
 */
export function useUserMenu({ whoami, identity, client, items = [], profile = true, onOpenProfile, onSignedOut, labels = {}, }) {
    const queryClient = useQueryClient();
    const forget = useForgetWhoami();
    const menuId = useId();
    const [open, setOpenState] = useState(false);
    const [profileOpen, setProfileOpen] = useState(false);
    const [signingOut, setSigningOut] = useState(false);
    const [error, setError] = useState(null);
    const setOpen = (next) => {
        setOpenState(next);
        if (!next)
            setProfileOpen(false);
    };
    const kind = !whoami ? null : whoami.kind === 'sso' ? 'sso' : 'guest';
    const isAdmin = whoami?.admin === true;
    const selection = whoami?.selection ?? null;
    const retained = selection !== null;
    const name = (whoami && identity?.name) || displayName(whoami);
    const signOutLabel = labels.signOut ?? 'Sign out';
    async function signOut() {
        if (signingOut)
            return;
        setSigningOut(true);
        setError(null);
        try {
            await client.logout({ selection });
            if (retained)
                announceSelectionChange(client.basePath);
            setOpen(false);
            forget();
            onSignedOut?.();
        }
        catch (e) {
            const conflict = e instanceof AuthClientError && e.status === 409;
            setError(conflict ? new SelectionConflictError() : new Error(labels.signOutFailed ?? 'Could not sign out. Please try again.'));
            // Still signed in, and possibly as someone else: show who, from the server.
            void queryClient.invalidateQueries({ queryKey: WHOAMI_KEY });
        }
        finally {
            setSigningOut(false);
        }
    }
    const visible = (when) => when === undefined || (when === 'admin' ? isAdmin : when === kind);
    const entries = !kind
        ? []
        : [
            ...(kind === 'sso' && profile
                ? [{
                        key: 'profile',
                        label: labels.profile ?? 'Profile',
                        onClick: () => {
                            if (onOpenProfile) {
                                setOpen(false);
                                onOpenProfile();
                            }
                            else
                                setProfileOpen(true);
                        },
                    }]
                : []),
            ...items
                .filter(item => visible(item.when))
                .map(({ key, label, href, onClick, content }) => ({
                key,
                label,
                ...(content === undefined ? {} : { content }),
                ...(href === undefined ? {} : { href }),
                onClick: (e) => {
                    onClick?.(e);
                    setOpen(false);
                },
            })),
            ...(retained ? [{ key: 'accounts', label: labels.accounts ?? 'Accounts' }] : []),
            { key: 'sign-out', label: signingOut ? (labels.signingOut ?? 'Signing out…') : signOutLabel, onClick: () => void signOut() },
        ];
    const triggerLabel = labels.trigger ?? (name ? `Signed in as ${name}` : 'Signed in with a share link');
    return {
        kind,
        displayName: name,
        avatar: whoami ? (identity?.avatar ?? whoami.subject?.avatar ?? null) : null,
        email: whoami?.email ?? null,
        isAdmin,
        retained,
        items: entries,
        open,
        setOpen,
        profileOpen,
        closeProfile: () => setProfileOpen(false),
        signOut,
        signingOut,
        error,
        triggerProps: {
            'aria-label': triggerLabel,
            'aria-haspopup': 'true',
            'aria-expanded': open,
            'aria-controls': open ? menuId : undefined,
            onClick: () => setOpen(!open),
        },
        menuProps: {
            id: menuId,
            // A dialog holding menus, not one menu: the identity header and the account
            // switcher's list aren't menu items.
            role: 'dialog',
            'aria-label': 'Account',
            onKeyDown: (e) => {
                if (e.key === 'Escape') {
                    setOpen(false);
                    return;
                }
                if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')
                    return;
                const all = Array.from(e.currentTarget.querySelectorAll('[role="menuitem"]'));
                if (!all.length)
                    return;
                e.preventDefault();
                const at = all.indexOf(document.activeElement);
                const step = e.key === 'ArrowDown' ? 1 : -1;
                const next = at === -1 ? (step === 1 ? 0 : all.length - 1) : (at + step + all.length) % all.length;
                all[next].focus();
            },
        },
    };
}
