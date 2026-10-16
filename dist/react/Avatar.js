import { jsx as _jsx } from "react/jsx-runtime";
import { useState } from 'react';
import { displayName } from './types.js';
/**
 * Up to two initials, code-point-safe so a name starting with an emoji or an
 * astral-plane character doesn't render half a surrogate pair.
 */
export function initialsOf(name) {
    const words = (name ?? '').trim().split(/\s+/).filter(Boolean);
    const picked = words.length > 1 ? [words[0], words[words.length - 1]] : words.slice(0, 1);
    return picked.map(w => Array.from(w)[0] ?? '').join('').toUpperCase();
}
/** A face for the chip and the request table: an image if there is one, else initials. */
export function Avatar({ whoami, name: nameProp, src, size = 24, className, initials }) {
    const [broken, setBroken] = useState(false);
    const name = nameProp ?? displayName(whoami);
    const subjectAvatar = whoami?.subject?.avatar;
    const url = src ?? subjectAvatar ?? null;
    const text = initials ?? initialsOf(name);
    const box = { width: size, height: size, borderRadius: '50%', flex: `0 0 ${size}px` };
    if (url && !broken) {
        return (_jsx("img", { className: className, src: url, alt: name ?? '', width: size, height: size, style: { ...box, objectFit: 'cover' }, onError: () => setBroken(true), 
            // The identity is private; don't hand the referrer to whoever hosts it.
            referrerPolicy: "no-referrer" }));
    }
    if (!text)
        return null;
    return (_jsx("span", { className: className, "aria-hidden": "true", style: {
            ...box,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: size * 0.42,
            lineHeight: 1,
        }, children: text }));
}
