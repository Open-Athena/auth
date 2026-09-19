import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
/**
 * The wall's third affordance: sign in with a code emailed to you, for the tail
 * of users who can't (or won't) use Google. Two steps — enter an address, then
 * enter the 6-digit code that arrives — because typing the code back into *this*
 * tab is what rescues the cross-device case (the mail is on your phone). The
 * matching magic link in the same email is the one-click path when it's the
 * same device.
 *
 * The server answers `start` identically whether or not the address is allowed,
 * so this form can't be used to probe the allowlist; a genuinely-not-allowed
 * person simply never receives a code and uses request-access instead.
 */
export function EmailCodeForm({ startEndpoint = '/api/auth/email/start', verifyEndpoint = '/api/auth/email/code', onSignedIn, defaultEmail = '', classNames = {}, labels = {}, sentHint = email => `Enter the code we emailed to ${email}, or open the link in that email.`, }) {
    const [state, setState] = useState('email');
    const [email, setEmail] = useState(defaultEmail);
    const [id, setId] = useState('');
    async function start(e) {
        e.preventDefault();
        if (state === 'sending')
            return;
        const addr = String(new FormData(e.currentTarget).get('email') ?? '').trim();
        setEmail(addr);
        setState('sending');
        try {
            const res = await fetch(startEndpoint, {
                method: 'POST',
                credentials: 'include',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ email: addr }),
            });
            const parsed = (await res.json().catch(() => ({})));
            // The response is constant for allowed and not-allowed addresses; either
            // way we advance to code entry (a not-allowed address just never gets one).
            if (res.ok && parsed.status === 'sent' && parsed.id) {
                setId(parsed.id);
                setState('code');
            }
            else {
                setState('error');
            }
        }
        catch {
            setState('error');
        }
    }
    async function verify(e) {
        e.preventDefault();
        if (state === 'verifying')
            return;
        const code = String(new FormData(e.currentTarget).get('code') ?? '').trim();
        setState('verifying');
        try {
            const res = await fetch(verifyEndpoint, {
                method: 'POST',
                credentials: 'include',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ id, code }),
            });
            const parsed = (await res.json().catch(() => ({})));
            if (res.ok && parsed.ok) {
                onSignedIn?.();
            }
            else {
                // Wrong or expired code: stay on the step so it can be retyped.
                setState('code');
            }
        }
        catch {
            setState('code');
        }
    }
    if (state === 'code' || state === 'verifying') {
        return (_jsxs("form", { className: classNames.form, onSubmit: verify, children: [_jsx("p", { className: classNames.message, children: sentHint(email) }), _jsxs("div", { className: classNames.field, children: [_jsx("label", { className: classNames.label, htmlFor: "oa-auth-code", children: labels.code ?? 'Code' }), _jsx("input", { className: classNames.input, id: "oa-auth-code", name: "code", inputMode: "numeric", autoComplete: "one-time-code", pattern: "[0-9]*", required: true })] }), _jsx("button", { className: classNames.button, type: "submit", disabled: state === 'verifying', children: state === 'verifying' ? (labels.verifying ?? 'Signing in…') : (labels.verify ?? 'Sign in') }), _jsx("button", { className: classNames.back, type: "button", onClick: () => setState('email'), disabled: state === 'verifying', children: labels.back ?? 'Use a different email' })] }));
    }
    return (_jsxs("form", { className: classNames.form, onSubmit: start, children: [_jsxs("div", { className: classNames.field, children: [_jsx("label", { className: classNames.label, htmlFor: "oa-auth-code-email", children: labels.email ?? 'Email' }), _jsx("input", { className: classNames.input, id: "oa-auth-code-email", name: "email", type: "email", required: true, autoComplete: "email", defaultValue: defaultEmail })] }), _jsx("button", { className: classNames.button, type: "submit", disabled: state === 'sending', children: state === 'sending' ? (labels.sending ?? 'Sending…') : (labels.send ?? 'Email me a code') }), state === 'error' && _jsx("p", { className: classNames.message, children: "Something went wrong. Try again?" })] }));
}
