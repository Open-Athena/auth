import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { Avatar } from './Avatar.js';
import { useForgetWhoami } from './useWhoami.js';
import { displayName } from './types.js';
/** Header chip: who you are, and how to stop being them. */
export function WhoamiChip({ whoami, logoutEndpoint = '/api/auth/logout', signOutLabel = 'Sign out', anonymousLabel = 'Anonymous link', onSignedOut, avatar = false, onOpenProfile, classNames = {}, }) {
    const forget = useForgetWhoami();
    const name = displayName(whoami);
    if (!whoami)
        return null;
    async function signOut() {
        if (logoutEndpoint)
            await fetch(logoutEndpoint, { method: 'POST', credentials: 'include' }).catch(() => { });
        forget();
        onSignedOut?.();
    }
    const face = avatar && (_jsx(Avatar, { whoami: whoami, className: classNames.avatar, ...(typeof avatar === 'object' ? avatar : {}) }));
    const label = _jsx("span", { className: classNames.name, children: name ?? anonymousLabel });
    return (_jsxs("div", { className: classNames.root, children: [onOpenProfile ? (
            // A single hit area over face + name, so "click your face → edit it"
            // needs no layout of the app's own.
            _jsxs("button", { className: classNames.identity, type: "button", onClick: onOpenProfile, children: [face, label] })) : (_jsxs(_Fragment, { children: [face, label] })), logoutEndpoint !== null && (_jsx("button", { className: classNames.button, type: "button", onClick: signOut, children: signOutLabel }))] }));
}
