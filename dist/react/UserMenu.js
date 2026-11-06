import { Fragment as _Fragment, jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { autoUpdate, flip, FloatingFocusManager, FloatingPortal, offset, shift, useDismiss, useFloating, useInteractions, } from '@floating-ui/react';
import { Fragment } from 'react';
import { AccountSwitcher } from './Accounts.js';
import { Avatar } from './Avatar.js';
import { ProfilePanel } from './ProfilePanel.js';
import { useUserMenu } from './useUserMenu.js';
const DEFAULTS = {
    trigger: 'oa-ui-um-trigger',
    popover: 'oa-ui oa-ui-um-pop',
    identity: 'oa-ui-um-identity',
    name: 'oa-ui-um-name',
    email: 'oa-ui-um-email',
    tag: 'oa-ui-tag',
    menu: 'oa-ui-um-menu',
    item: 'oa-ui-um-item',
    back: 'oa-ui-um-item',
    error: 'oa-ui-error',
};
/**
 * The upper-right menu: an avatar opening who you are, Profile, the app's own
 * entries, retained accounts, and sign out. Built only on `useUserMenu`, so an
 * app can restyle this or write its own. A share link is always labelled as one,
 * so a guest can't pass for a verified person by name and face.
 */
export function UserMenu({ whoami, client, signedOut = null, addAccountHref, anonymousLabel = 'Anonymous link', guestLabel = 'share link', backLabel = 'Back', size = 28, accountSwitcher, profilePanel, classNames, ...options }) {
    const cx = { ...DEFAULTS, ...classNames };
    const m = useUserMenu({ whoami, client, ...options });
    const { refs, floatingStyles, context } = useFloating({
        open: m.open,
        onOpenChange: m.setOpen,
        placement: 'bottom-end',
        middleware: [offset(6), flip(), shift({ padding: 8 })],
        whileElementsMounted: autoUpdate,
    });
    const { getReferenceProps, getFloatingProps } = useInteractions([useDismiss(context)]);
    if (whoami === undefined)
        return null;
    if (!m.kind)
        return _jsx(_Fragment, { children: signedOut });
    const row = (entry) => entry.content !== undefined ? (_jsx(Fragment, { children: entry.content }, entry.key)) : entry.href === undefined ? (_jsx("button", { type: "button", role: "menuitem", className: cx.item, disabled: entry.key === 'sign-out' && m.signingOut, onClick: entry.onClick, children: entry.label }, entry.key)) : (_jsx("a", { role: "menuitem", className: cx.item, href: entry.href, onClick: entry.onClick, children: entry.label }, entry.key));
    const at = m.items.findIndex(entry => entry.key === 'accounts');
    const before = at === -1 ? m.items.slice(0, -1) : m.items.slice(0, at);
    const signOut = m.items[m.items.length - 1];
    return (_jsxs(_Fragment, { children: [_jsx("button", { type: "button", className: cx.trigger, ref: refs.setReference, ...getReferenceProps(m.triggerProps), children: _jsx(Avatar, { src: m.avatar, name: m.displayName, size: size, initials: m.displayName ? undefined : '?' }) }), m.open && (_jsx(FloatingPortal, { children: _jsx(FloatingFocusManager, { context: context, modal: false, children: _jsx("div", { className: cx.popover, ref: refs.setFloating, style: floatingStyles, ...getFloatingProps(m.menuProps), children: m.profileOpen ? (_jsxs(_Fragment, { children: [_jsx("button", { type: "button", className: cx.back, onClick: m.closeProfile, children: backLabel }), _jsx(ProfilePanel, { endpoint: `${client.basePath}/profile`, whoami: whoami, onSaved: m.closeProfile, ...profilePanel })] })) : (_jsxs(_Fragment, { children: [_jsxs("div", { className: cx.identity, children: [_jsx(Avatar, { src: m.avatar, name: m.displayName, size: 36, initials: m.displayName ? undefined : '?' }), _jsxs("div", { children: [_jsx("div", { className: cx.name, children: m.displayName ?? anonymousLabel }), m.email && m.email !== m.displayName && _jsx("div", { className: cx.email, children: m.email }), m.kind === 'guest' && _jsx("span", { className: cx.tag, children: guestLabel })] })] }), before.length > 0 && (_jsx("div", { role: "menu", className: cx.menu, children: before.map(row) })), at !== -1 && (_jsx(AccountSwitcher, { basePath: client.basePath, addAccountHref: addAccountHref, hideSignOut: true, onChanged: () => m.setOpen(false), ...accountSwitcher })), _jsx("div", { role: "menu", className: cx.menu, children: row(signOut) }), m.error && (_jsx("p", { className: cx.error, role: "alert", children: m.error.message }))] })) }) }) }))] }));
}
