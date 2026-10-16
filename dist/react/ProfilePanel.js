import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { Avatar } from './Avatar.js';
import { AvatarField } from './AvatarField.js';
import { useForgetWhoami } from './useWhoami.js';
import { displayName } from './types.js';
const asSubject = (whoami) => whoami?.subject ?? {};
/**
 * Let a signed-in principal set their own display name and face. Unstyled, like
 * the rest of `react/`: every visible string and class is a prop.
 *
 * The face comes from `<AvatarField>` (a profile, an image address, an upload,
 * or Gravatar on request), and is copied server-side on save — nothing here
 * ever persists a live third-party URL.
 */
export function ProfilePanel({ endpoint = '/api/auth/profile', avatarEndpoint = endpoint.replace(/\/profile$/, '/avatar'), whoami, onSaved, classNames = {}, labels = {}, }) {
    const seed = asSubject(whoami);
    const forget = useForgetWhoami();
    const [name, setName] = useState(seed.name ?? '');
    // `undefined` = keep the current face; `null` = clear it; a `data:` URI = replace.
    const [avatar, setAvatar] = useState(undefined);
    const [state, setState] = useState('idle');
    const [error, setError] = useState(null);
    async function save(e) {
        e.preventDefault();
        if (state === 'saving')
            return;
        setState('saving');
        setError(null);
        try {
            const res = await fetch(endpoint, {
                method: 'PUT',
                credentials: 'include',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ name, ...(avatar === undefined ? {} : { avatar: avatar === null ? null : { ref: avatar } }) }),
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
    return (_jsxs("form", { className: classNames.form, onSubmit: save, children: [_jsx("div", { className: classNames.preview, children: _jsx(Avatar, { src: avatar === undefined ? (seed.avatar ?? null) : avatar, name: name.trim() || displayName(whoami), size: 64 }) }), _jsxs("div", { className: classNames.field, children: [_jsx("label", { className: classNames.label, htmlFor: "oa-profile-name", children: labels.name ?? 'Name' }), _jsx("input", { className: classNames.input, id: "oa-profile-name", type: "text", autoComplete: "name", value: name, onChange: e => setName(e.target.value) })] }), _jsxs("div", { className: classNames.field, children: [_jsx("label", { className: classNames.label, htmlFor: "oa-profile-avatar", children: labels.avatar ?? 'Avatar' }), _jsx(AvatarField, { id: "oa-profile-avatar", endpoint: avatarEndpoint, value: avatar ?? null, onChange: setAvatar, email: whoami?.email ?? null, autoGravatar: false, preview: false, ...(classNames.avatar ? { classNames: classNames.avatar } : {}), ...(labels.avatarField ? { labels: labels.avatarField } : {}) })] }), _jsx("button", { className: classNames.button, type: "submit", disabled: state === 'saving', children: state === 'saving' ? (labels.saving ?? 'Saving…') : (labels.save ?? 'Save profile') }), state === 'saved' && _jsx("p", { className: classNames.message, children: labels.saved ?? 'Saved.' }), state === 'error' && error && _jsx("p", { className: classNames.message, children: error })] }));
}
