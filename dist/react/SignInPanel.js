import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
import { RequestAccessForm } from './RequestAccessForm.js';
function withNextParam(url) {
    if (typeof window === 'undefined')
        return url;
    const next = window.location.pathname + window.location.search;
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}next=${encodeURIComponent(next)}`;
}
/**
 * The wall. Two affordances — SSO for staff, request-access for everyone else —
 * because the alternative for an external is emailing an admin and waiting,
 * which is how share links end up forwarded instead of minted.
 *
 * A revoked or expired link should land *here*, not on a bare 403: the person
 * who legitimately lost access self-serves, and the person who shouldn't have
 * it hits a door that names itself.
 */
export function SignInPanel({ signInUrl, withNext = true, title = 'This page is private', hint, signInLabel = 'Sign in', requestAccess, children, classNames = {}, }) {
    const href = signInUrl && withNext ? withNextParam(signInUrl) : signInUrl;
    return (_jsxs("div", { className: classNames.root, children: [title && _jsx("h1", { className: classNames.title, children: title }), hint && _jsx("p", { className: classNames.hint, children: hint }), href && (_jsx("a", { className: classNames.button, href: href, children: signInLabel })), children, requestAccess && (_jsxs(_Fragment, { children: [href && _jsx("div", { className: classNames.divider }), _jsx(RequestAccessForm, { ...(requestAccess === true ? {} : requestAccess) })] }))] }));
}
