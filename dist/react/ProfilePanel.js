import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { Avatar } from './Avatar.js';
import { useForgetWhoami } from './useWhoami.js';
import { displayName } from './types.js';
const AVATAR_LABELS = {
    keep: 'Keep current',
    upload: 'Upload a file',
    url: 'From a URL',
    github: 'From GitHub',
    gravatar: 'From Gravatar (my email)',
    clear: 'Clear (use initials)',
};
const asSubject = (whoami) => whoami?.subject ?? {};
/**
 * Let a signed-in principal set their own display name and face. Unstyled, like
 * the rest of `react/`: every visible string and class is a prop.
 *
 * The avatar is always copied server-side (`PUT /api/profile` calls
 * `resolveAvatar`/`validateUploadedImage`), so nothing here ever persists a live
 * third-party URL — a paste of an image URL is fetched once and inlined, not
 * rendered from its origin on every view.
 */
export function ProfilePanel({ endpoint = '/api/auth/profile', whoami, onSaved, classNames = {}, labels = {}, }) {
    const seed = asSubject(whoami);
    const forget = useForgetWhoami();
    const [first, setFirst] = useState(seed.first ?? '');
    const [last, setLast] = useState(seed.last ?? '');
    const [choice, setChoice] = useState('keep');
    const [url, setUrl] = useState('');
    const [github, setGithub] = useState('');
    const [file, setFile] = useState(null);
    const [state, setState] = useState('idle');
    const [error, setError] = useState(null);
    async function save(e) {
        e.preventDefault();
        if (state === 'saving')
            return;
        setState('saving');
        setError(null);
        try {
            const res = choice === 'upload' && file
                ? await fetch(endpoint, { method: 'PUT', credentials: 'include', body: uploadBody(first, last, file) })
                : await fetch(endpoint, {
                    method: 'PUT',
                    credentials: 'include',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ first, last, ...avatarField(choice, url, github) }),
                });
            if (res.ok) {
                setState('saved');
                forget(); // refetch whoami so the chip picks up the new name/face
                onSaved?.();
            }
            else {
                const b = (await res.json().catch(() => ({})));
                setState('error');
                setError(b.detail ?? b.error ?? 'Could not save your profile.');
            }
        }
        catch {
            setState('error');
            setError('Could not save your profile.');
        }
    }
    const label = (k) => labels[k] ?? AVATAR_LABELS[k];
    return (_jsxs("form", { className: classNames.form, onSubmit: save, children: [_jsx("div", { className: classNames.preview, children: _jsx(Avatar, { whoami: whoami, name: [first, last].filter(Boolean).join(' ') || displayName(whoami), size: 64 }) }), _jsxs("div", { className: classNames.field, children: [_jsx("label", { className: classNames.label, htmlFor: "oa-profile-first", children: labels.first ?? 'First name' }), _jsx("input", { className: classNames.input, id: "oa-profile-first", type: "text", autoComplete: "given-name", value: first, onChange: e => setFirst(e.target.value) })] }), _jsxs("div", { className: classNames.field, children: [_jsx("label", { className: classNames.label, htmlFor: "oa-profile-last", children: labels.last ?? 'Last name' }), _jsx("input", { className: classNames.input, id: "oa-profile-last", type: "text", autoComplete: "family-name", value: last, onChange: e => setLast(e.target.value) })] }), _jsxs("div", { className: classNames.field, children: [_jsx("label", { className: classNames.label, htmlFor: "oa-profile-avatar", children: labels.avatar ?? 'Avatar' }), _jsx("select", { className: classNames.select, id: "oa-profile-avatar", value: choice, onChange: e => setChoice(e.target.value), children: Object.keys(AVATAR_LABELS).map(k => (_jsx("option", { value: k, children: label(k) }, k))) })] }), choice === 'upload' && (_jsx("div", { className: classNames.field, children: _jsx("input", { className: classNames.input, type: "file", accept: "image/png,image/jpeg,image/webp,image/gif", onChange: e => setFile(e.target.files?.[0] ?? null) }) })), choice === 'url' && (_jsx("div", { className: classNames.field, children: _jsx("input", { className: classNames.input, type: "url", placeholder: "https://\u2026", value: url, onChange: e => setUrl(e.target.value) }) })), choice === 'github' && (_jsx("div", { className: classNames.field, children: _jsx("input", { className: classNames.input, type: "text", placeholder: "github-handle", value: github, onChange: e => setGithub(e.target.value) }) })), _jsx("button", { className: classNames.button, type: "submit", disabled: state === 'saving', children: state === 'saving' ? (labels.saving ?? 'Saving…') : (labels.save ?? 'Save profile') }), state === 'saved' && _jsx("p", { className: classNames.message, children: labels.saved ?? 'Saved.' }), state === 'error' && error && _jsx("p", { className: classNames.message, children: error })] }));
}
function avatarField(choice, url, github) {
    switch (choice) {
        case 'url':
            return { avatar: { url } };
        case 'github':
            return { avatar: { github } };
        case 'gravatar':
            return { avatar: { gravatar: true } };
        case 'clear':
            return { avatar: null };
        default:
            return {}; // 'keep' (and 'upload' handled via multipart) leave it unchanged
    }
}
function uploadBody(first, last, file) {
    const fd = new FormData();
    fd.set('first', first);
    fd.set('last', last);
    fd.set('avatar', file);
    return fd;
}
