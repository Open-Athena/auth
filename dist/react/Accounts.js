import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { createAccountsClient, onSelectionChange, SelectionConflictError } from '../client/accounts.js';
import { Avatar } from './Avatar.js';
import { WHOAMI_KEY } from './useWhoami.js';
export const ACCOUNTS_KEY = ['oa-auth', 'accounts'];
/**
 * A browser's retained logins (a gate in `retained` mode): the list, and every
 * way to change it. After any change, here or in another tab, the identity
 * and the list are re-read from the server, and the private data an app keys
 * by identity should be too: watch `accounts.active` or the whoami query.
 */
export function useAccounts({ basePath = '/api/auth', enabled = true } = {}) {
    const qc = useQueryClient();
    const api = useMemo(() => createAccountsClient({ basePath }), [basePath]);
    const key = [...ACCOUNTS_KEY, basePath];
    const q = useQuery({ queryKey: key, queryFn: () => api.list(), enabled, retry: false, refetchOnWindowFocus: true });
    const refreshAll = () => {
        void qc.invalidateQueries({ queryKey: [...ACCOUNTS_KEY, basePath] });
        void qc.invalidateQueries({ queryKey: WHOAMI_KEY });
    };
    // Another tab switched or signed out: look again.
    useEffect(() => onSelectionChange(() => {
        void qc.invalidateQueries({ queryKey: [...ACCOUNTS_KEY, basePath] });
        void qc.invalidateQueries({ queryKey: WHOAMI_KEY });
    }, basePath), [qc, basePath]);
    const m = useMutation({
        mutationFn: run => run(),
        onSuccess: data => {
            if (data && typeof data === 'object' && 'accounts' in data)
                qc.setQueryData(key, data);
            // The identity changed (or may have): every observer re-reads it, rather
            // than rendering the previous account's view for a moment.
            void qc.resetQueries({ queryKey: WHOAMI_KEY });
            void qc.invalidateQueries({ queryKey: key });
        },
        onError: e => {
            if (e instanceof SelectionConflictError)
                refreshAll();
        },
    });
    const selection = () => q.data?.selection ?? null;
    const run = (f) => m.mutateAsync(f).then(() => { }, () => { });
    return {
        accounts: enabled && q.isPending ? undefined : (q.data ?? null),
        select: id => run(() => api.select(id, selection())),
        remove: id => run(() => api.remove(id, selection())),
        acceptIncoming: id => run(() => api.acceptIncoming(id, selection())),
        signOut: () => run(() => api.logout(selection())),
        signOutAll: () => run(() => api.logoutAll()),
        busy: m.isPending,
        error: m.error,
    };
}
const who = (a) => a.subject?.name ?? (a.kind === 'grant' ? (a.name ?? a.email ?? 'Share link') : (a.email ?? a.name ?? 'Account'));
/**
 * The browser's accounts: switch with one click, add another, take one off,
 * or sign out of all. A share-link login is always labelled as one, so a
 * guest can't pass for a verified person by name and face. With a single
 * account and no incoming link it is just that account and the sign-out
 * actions: no picker to step through.
 */
export function AccountSwitcher({ basePath, addAccountHref, onChanged, labels = {}, classNames = {} }) {
    const a = useAccounts({ basePath });
    const l = {
        heading: 'Accounts',
        add: 'Add another account',
        signOut: 'Sign out',
        signOutAll: 'Sign out of all accounts',
        remove: 'Remove',
        link: 'share link',
        verified: 'verified',
        incoming: 'Opened a share link',
        useLink: 'Use it',
        current: 'current',
        ...labels,
    };
    if (!a.accounts)
        return null;
    const { accounts, incoming } = a.accounts;
    const done = (p) => p.then(() => !a.error && onChanged?.());
    const many = accounts.length > 1;
    const row = (x) => (_jsxs("li", { className: [classNames.item, x.active && classNames.active].filter(Boolean).join(' ') || undefined, children: [_jsxs("button", { type: "button", className: classNames.switch, disabled: a.busy || x.active, "aria-current": x.active ? 'true' : undefined, onClick: () => done(a.select(x.id)), children: [_jsx(Avatar, { src: x.subject?.avatar ?? null, name: who(x), size: 24 }), _jsx("span", { children: who(x) }), x.email && who(x) !== x.email && _jsx("span", { children: x.email }), _jsx("span", { className: classNames.tag, children: x.kind === 'grant' ? l.link : l.verified }), x.active && many && _jsx("span", { className: classNames.tag, children: l.current })] }), many && (_jsx("button", { type: "button", className: classNames.remove, disabled: a.busy, onClick: () => done(a.remove(x.id)), "aria-label": `${l.remove} ${who(x)}`, children: "\u00D7" }))] }, x.id));
    const offer = (i) => (_jsxs("li", { className: classNames.incoming, children: [_jsxs("span", { children: [l.incoming, ": ", who({ ...i, kind: 'grant' }), " ", _jsx("span", { className: classNames.tag, children: l.link })] }), _jsx("button", { type: "button", className: classNames.button, disabled: a.busy, onClick: () => done(a.acceptIncoming(i.id)), children: l.useLink })] }, i.id));
    return (_jsxs("div", { className: classNames.root, role: "group", "aria-label": typeof l.heading === 'string' ? l.heading : 'Accounts', children: [_jsxs("ul", { className: classNames.list, children: [accounts.map(row), incoming.map(offer)] }), a.error && (_jsx("p", { className: classNames.error, role: "alert", children: a.error.message })), _jsxs("div", { className: classNames.actions, children: [addAccountHref && (_jsx("a", { className: classNames.button, href: addAccountHref, children: l.add })), accounts.some(x => x.active) && (_jsx("button", { type: "button", className: classNames.button, disabled: a.busy, onClick: () => done(a.signOut()), children: l.signOut })), many && (_jsx("button", { type: "button", className: classNames.button, disabled: a.busy, onClick: () => done(a.signOutAll()), children: l.signOutAll }))] })] }));
}
