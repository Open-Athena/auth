import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
const MESSAGES = {
    pending: "Thanks — we'll email you a link once someone approves it.",
    invalid: "That doesn't look like an email address.",
    'rate-limited': "That's a lot of requests. Try again in a little while.",
    error: 'Something went wrong. Try again?',
};
/**
 * The wall's second affordance, for everyone who isn't staff. Unstyled: every
 * visible string and class is a prop, because the wall's copy is exactly the
 * part each app needs to own.
 */
export function RequestAccessForm({ endpoint = '/api/auth/request', honeypotField = 'website', askName = true, askNote = true, notePlaceholder = 'Anything that helps us place you (optional)', onSubmitted, classNames = {}, labels = {}, }) {
    const [state, setState] = useState('idle');
    async function submit(e) {
        e.preventDefault();
        if (state === 'submitting' || state === 'pending')
            return;
        const data = Object.fromEntries(new FormData(e.currentTarget).entries());
        setState('submitting');
        try {
            const res = await fetch(endpoint, {
                method: 'POST',
                credentials: 'include',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(data),
            });
            const parsed = (await res.json().catch(() => ({})));
            const next = parsed.status && parsed.status in MESSAGES ? parsed.status : res.ok ? 'pending' : 'error';
            setState(next);
            onSubmitted?.(next);
        }
        catch {
            setState('error');
            onSubmitted?.('error');
        }
    }
    if (state === 'pending')
        return _jsx("p", { className: classNames.message, children: MESSAGES.pending });
    return (_jsxs("form", { className: classNames.form, onSubmit: submit, children: [_jsxs("div", { className: classNames.field, children: [_jsx("label", { className: classNames.label, htmlFor: "oa-auth-email", children: labels.email ?? 'Email' }), _jsx("input", { className: classNames.input, id: "oa-auth-email", name: "email", type: "email", required: true, autoComplete: "email" })] }), askName && (_jsxs("div", { className: classNames.field, children: [_jsx("label", { className: classNames.label, htmlFor: "oa-auth-name", children: labels.name ?? 'Name' }), _jsx("input", { className: classNames.input, id: "oa-auth-name", name: "name", type: "text", autoComplete: "name" })] })), askNote && (_jsxs("div", { className: classNames.field, children: [_jsx("label", { className: classNames.label, htmlFor: "oa-auth-note", children: labels.note ?? 'Note' }), _jsx("textarea", { className: classNames.input, id: "oa-auth-note", name: "note", rows: 2, placeholder: notePlaceholder })] })), _jsx("input", { name: honeypotField, type: "text", tabIndex: -1, autoComplete: "off", "aria-hidden": "true", style: { position: 'absolute', left: '-9999px', width: 1, height: 1, opacity: 0 } }), _jsx("button", { className: classNames.button, type: "submit", disabled: state === 'submitting', children: state === 'submitting' ? (labels.submitting ?? 'Sending…') : (labels.submit ?? 'Request access') }), state !== 'idle' && state !== 'submitting' && _jsx("p", { className: classNames.message, children: MESSAGES[state] })] }));
}
