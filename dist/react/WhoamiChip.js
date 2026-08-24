import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Avatar } from './Avatar.js';
import { useForgetWhoami } from './useWhoami.js';
import { displayName } from './types.js';
/** Header chip: who you are, and how to stop being them. */
export function WhoamiChip({ whoami, logoutEndpoint = '/api/auth/logout', signOutLabel = 'Sign out', anonymousLabel = 'Anonymous link', onSignedOut, avatar = false, classNames = {}, }) {
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
    return (_jsxs("div", { className: classNames.root, children: [avatar && (_jsx(Avatar, { whoami: whoami, className: classNames.avatar, ...(typeof avatar === 'object' ? avatar : {}) })), _jsx("span", { className: classNames.name, children: name ?? anonymousLabel }), logoutEndpoint !== null && (_jsx("button", { className: classNames.button, type: "button", onClick: signOut, children: signOutLabel }))] }));
}
