import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { EmailCodeForm } from './EmailCodeForm.js';
import { GoogleOneTap } from './GoogleOneTap.js';
import { RequestAccessForm } from './RequestAccessForm.js';
const withParam = (url, k, v) => `${url}${url.includes('?') ? '&' : '?'}${k}=${encodeURIComponent(v)}`;
function withNextParam(url) {
    if (typeof window === 'undefined')
        return url;
    return withParam(url, 'next', window.location.pathname + window.location.search);
}
const defaultContinueAs = (email) => `Continue as ${email}`;
const defaultSwitchAccount = (email) => `Not ${email}? Use another Google account`;
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
export function SignInPanel({ googleUrl, googleLabel = 'Continue with Google', oneTap, continueAs = defaultContinueAs, switchAccount = defaultSwitchAccount, withNext = true, emailAuth, onSignedIn, title = 'This page is private', hint, requestAccess, children, classNames = {}, }) {
    const google = googleUrl && withNext ? withNextParam(googleUrl) : googleUrl;
    const denied = deniedEmail();
    const [remembered, setRemembered] = useState(null);
    const anyPrimary = Boolean(google || oneTap);
    const hinted = Boolean(google && remembered && continueAs);
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
    return (_jsxs("div", { className: classNames.root, children: [title && _jsx("h1", { className: classNames.title, children: title }), hint && _jsx("p", { className: classNames.hint, children: hint }), hinted && (_jsx("a", { className: classNames.googleButton ?? classNames.button, href: google, children: continueAs && remembered && continueAs(remembered) })), oneTap ? (
            // `contents` keeps the wrapper out of the panel's layout.
            _jsx("div", { style: { display: hinted ? 'none' : 'contents' }, children: _jsx(GoogleOneTap, { ...oneTap, ...(onSignedIn ? { onSignedIn } : {}), onAccountHint: email => {
                        setRemembered(email);
                        oneTap.onAccountHint?.(email);
                    }, fallback: redirect || null }) })) : (redirect), google && remembered && switchAccount && (_jsx("a", { className: classNames.switchAccount, href: withParam(google, 'account', 'choose'), children: switchAccount(remembered) })), emailAuth && (_jsxs(_Fragment, { children: [anyPrimary && _jsx("div", { className: classNames.divider }), _jsx(EmailCodeForm, { ...emailProps })] })), children, requestAccess && (_jsxs(_Fragment, { children: [(anyPrimary || emailAuth) && _jsx("div", { className: classNames.divider }), _jsx(RequestAccessForm, { ...requestProps })] }))] }));
}
