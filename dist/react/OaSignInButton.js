import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { OA_MARK, firstName, oaSignInClasses } from '../signin/index.js';
/** The Open Athena mark (`OA_MARK`). */
export function OaMark({ size = 22 }) {
    return (_jsxs("svg", { className: "oa-signin-mark", width: size, height: size, viewBox: OA_MARK.viewBox, "aria-hidden": "true", focusable: "false", children: [_jsx("g", { className: "oa-signin-ring", fillRule: "evenodd", children: OA_MARK.rings.map(d => _jsx("path", { d: d }, d)) }), _jsx("g", { className: "oa-signin-stem", children: OA_MARK.stems.map(d => _jsx("path", { d: d }, d)) })] }));
}
export const OA_BRAND = { name: 'OA', mark: _jsx(OaMark, {}) };
/**
 * "Sign in with OA": a link to the app's broker sign-in (`/auth/oa`), styled to sit beside Google's button (40px tall,
 * mark at the start, label centered). Import `@open-athena/auth/react/ui.css` for its styles. `variant`: see
 * `OaSignInVariant` (`/signin`, which has the same button as an HTML string).
 */
export function OaSignInButton({ href, variant = 'taupe', label, account, brand = OA_BRAND, className }) {
    const classes = oaSignInClasses(variant, !!account, className);
    const mark = _jsx("span", { className: "oa-signin-logo", children: brand.mark });
    if (account) {
        const first = firstName(account);
        return (_jsxs("a", { className: classes, href: href, children: [account.avatar
                    ? _jsx("img", { className: "oa-signin-avatar", src: account.avatar, alt: "", referrerPolicy: "no-referrer" })
                    : _jsx("span", { className: "oa-signin-avatar", "aria-hidden": "true", children: (first ?? account.email).charAt(0).toUpperCase() }), _jsxs("span", { className: "oa-signin-who", children: [_jsxs("span", { className: "oa-signin-name", children: ["Continue as ", first ?? account.email] }), first && _jsx("span", { className: "oa-signin-email", children: account.email })] }), mark] }));
    }
    return (_jsxs("a", { className: classes, href: href, children: [mark, _jsx("span", { className: "oa-signin-label", children: label ?? `Sign in with ${brand.name}` }), _jsx("span", { className: "oa-signin-spacer", "aria-hidden": "true" })] }));
}
