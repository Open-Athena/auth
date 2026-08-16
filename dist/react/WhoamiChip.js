import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useForgetWhoami } from './useWhoami.js';
import { displayName } from './types.js';
/** Header chip: who you are, and how to stop being them. */
export function WhoamiChip({ whoami, logoutEndpoint = '/api/auth/logout', signOutLabel = 'Sign out', onSignedOut, classNames = {}, }) {
    const forget = useForgetWhoami();
    const name = displayName(whoami);
    if (!whoami || !name)
        return null;
    async function signOut() {
        if (logoutEndpoint)
            await fetch(logoutEndpoint, { method: 'POST', credentials: 'include' }).catch(() => { });
        forget();
        onSignedOut?.();
    }
    return (_jsxs("div", { className: classNames.root, children: [_jsx("span", { className: classNames.name, children: name }), logoutEndpoint !== null && (_jsx("button", { className: classNames.button, type: "button", onClick: signOut, children: signOutLabel }))] }));
}
