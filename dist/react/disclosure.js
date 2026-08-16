import { jsxs as _jsxs, jsx as _jsx } from "react/jsx-runtime";
import { displayName } from './types.js';
/**
 * *"Private link for Bob Smith · access is logged"* — the single
 * highest-leverage feature here. It sets accurate expectations, so nobody is
 * betrayed by discovering the log later, and it empirically dampens casual
 * forwarding harder than technical controls do, because the recipient now knows
 * the link is attributable to them.
 */
export function AccessNotice({ whoami, logged = true, viewCount = null, className, children }) {
    const name = displayName(whoami);
    if (!name)
        return null;
    return (_jsxs("p", { className: className, children: ["Private link for ", name, logged && ' · access is logged', viewCount !== null && ` · you've viewed this ${viewCount} ${viewCount === 1 ? 'time' : 'times'}`, children] }));
}
/**
 * The data-room convention: render the recipient's name across the page so
 * screenshots stay attributable. Only the styles that make it *work* are inline
 * (it must not intercept clicks, and it must cover the viewport); colour,
 * opacity and rotation are left to `className`, since that's branding.
 */
export function Watermark({ whoami, text, count = 60, className }) {
    const label = text ?? displayName(whoami);
    if (!label)
        return null;
    const style = {
        position: 'fixed',
        inset: 0,
        pointerEvents: 'none',
        userSelect: 'none',
        overflow: 'hidden',
        zIndex: 9999,
    };
    return (_jsx("div", { "aria-hidden": "true", className: className, style: style, children: Array.from({ length: count }, (_, i) => (_jsxs("span", { children: [label, " "] }, i))) }));
}
