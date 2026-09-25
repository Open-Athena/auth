import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
import { EmailCodeForm } from './EmailCodeForm.js';
import { GoogleOneTap } from './GoogleOneTap.js';
import { RequestAccessForm } from './RequestAccessForm.js';
function withNextParam(url) {
    if (typeof window === 'undefined')
        return url;
    const next = window.location.pathname + window.location.search;
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}next=${encodeURIComponent(next)}`;
}
/**
 * The address a denied sign-in redirected back with (`/?denied=<email>`). Google
 * (or an email link) verified it, so pre-filling request-access with it means an
 * admin approves an address that was *proven*, not merely typed.
 */
export function deniedEmail() {
    if (typeof window === 'undefined')
        return undefined;
    return new URL(window.location.href).searchParams.get('denied') ?? undefined;
}
/**
 * The wall. Google-first (one button, no typing), with two fallbacks — an
 * emailed code for the non-Google tail, and request-access for everyone the
 * allowlist doesn't yet know. A revoked or expired link should land *here*, not
 * on a bare 403: the person who legitimately lost access self-serves, and the
 * person who shouldn't have it hits a door that names itself.
 */
export function SignInPanel({ googleUrl, googleLabel = 'Continue with Google', oneTap, signInUrl, withNext = true, emailAuth, onSignedIn, title = 'This page is private', hint, signInLabel = 'Sign in', requestAccess, children, classNames = {}, }) {
    const google = googleUrl && withNext ? withNextParam(googleUrl) : googleUrl;
    const href = signInUrl && withNext ? withNextParam(signInUrl) : signInUrl;
    const denied = deniedEmail();
    const anyPrimary = Boolean(google || oneTap || href);
    const redirect = google && (_jsx("a", { className: classNames.googleButton ?? classNames.button, href: google, children: googleLabel }));
    const emailProps = {
        ...(denied ? { defaultEmail: denied } : {}),
        ...(onSignedIn ? { onSignedIn } : {}),
        ...(emailAuth === true ? {} : emailAuth),
    };
    const requestProps = {
        ...(denied ? { defaultEmail: denied } : {}),
        ...(requestAccess === true ? {} : requestAccess),
    };
    return (_jsxs("div", { className: classNames.root, children: [title && _jsx("h1", { className: classNames.title, children: title }), hint && _jsx("p", { className: classNames.hint, children: hint }), oneTap ? (_jsx(GoogleOneTap, { ...oneTap, ...(onSignedIn ? { onSignedIn } : {}), fallback: redirect || null })) : (redirect), href && (_jsx("a", { className: classNames.button, href: href, children: signInLabel })), emailAuth && (_jsxs(_Fragment, { children: [anyPrimary && _jsx("div", { className: classNames.divider }), _jsx(EmailCodeForm, { ...emailProps })] })), children, requestAccess && (_jsxs(_Fragment, { children: [(anyPrimary || emailAuth) && _jsx("div", { className: classNames.divider }), _jsx(RequestAccessForm, { ...requestProps })] }))] }));
}
