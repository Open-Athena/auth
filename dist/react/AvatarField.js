import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useRef, useState } from 'react';
import { Avatar } from './Avatar.js';
import { downscaleDataUri, downscaleImage } from '../client/image.js';
export { downscaleImage } from '../client/image.js';
const SOURCE_LABELS = {
    github: 'From GitHub',
    bluesky: 'From Bluesky',
    mastodon: 'From Mastodon',
    gravatar: 'From Gravatar',
    url: 'From image URL',
    site: "From the site's icon",
    upload: 'Uploaded',
};
const EMAILISH = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/**
 * One field for a person's face: paste a GitHub / Bluesky / Mastodon profile
 * (or handle), or an image address, or upload a file — or leave it empty and
 * get their Gravatar. Every option previews *before* anything is saved, via the
 * server, which fetches and sniffs the image; what comes back is a `data:` URI,
 * and that copy is what gets stored — never a link to the third party.
 *
 * LinkedIn, X and Facebook have no public way to fetch a profile photo, so a
 * pasted profile URL from them is refused with a pointer to "copy image
 * address" or an upload. Every face is downscaled in the browser before it's
 * stored (see `downscaleImage`), which also re-encodes away EXIF — so no
 * server-side image codec or resizing service is needed.
 */
export function AvatarField({ endpoint = '/api/auth/avatar', value, onChange, email, autoGravatar = true, name, preview = true, size = 48, uploadSize = 256, id = 'oa-avatar-ref', classNames = {}, labels = {}, }) {
    const [text, setText] = useState('');
    const [status, setStatus] = useState({ kind: 'idle' });
    // Set by an upload, a clear, or an explicit Gravatar ask: the text/email
    // effect must not then overwrite the choice with an automatic lookup.
    const [pinned, setPinned] = useState(false);
    const [gravatarAsked, setGravatarAsked] = useState(false);
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;
    // Whether this field has reported anything yet: until it has, an empty field
    // is "untouched", not "cleared" — `ProfilePanel` reads that as "keep".
    const emitted = useRef(false);
    const emit = (v) => {
        emitted.current = true;
        onChangeRef.current(v);
    };
    const fileRef = useRef(null);
    const trimmedEmail = email?.trim() ?? '';
    const wantGravatar = !text.trim() && EMAILISH.test(trimmedEmail) && (autoGravatar || gravatarAsked);
    useEffect(() => {
        if (pinned)
            return;
        const ref = text.trim();
        if (!ref && !wantGravatar) {
            setStatus({ kind: 'idle' });
            if (emitted.current)
                emit(null);
            return;
        }
        const ctl = new AbortController();
        // Debounced: a lookup per keystroke would hammer the server and the provider.
        const timer = setTimeout(async () => {
            setStatus({ kind: 'looking' });
            try {
                const res = await fetch(endpoint, {
                    method: 'POST',
                    credentials: 'include',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify(ref ? { ref } : { email: trimmedEmail }),
                    signal: ctl.signal,
                });
                const b = (await res.json().catch(() => ({})));
                if (!res.ok) {
                    setStatus({ kind: 'error', detail: b.detail ?? b.error ?? `lookup failed (HTTP ${res.status})` });
                    emit(null);
                    return;
                }
                const source = b.source ?? 'url';
                // The server returns what the source serves (up to its preview cap);
                // the copy that gets stored is this downscale.
                const face = b.avatar ? await downscaleDataUri(b.avatar, uploadSize) : null;
                if (ctl.signal.aborted)
                    return;
                setStatus(face ? { kind: 'found', source } : { kind: 'none', source });
                emit(face);
            }
            catch (e) {
                if (e.name === 'AbortError')
                    return;
                setStatus({ kind: 'error', detail: e.svg ? e.message : 'lookup failed' });
                emit(null);
            }
        }, 400);
        return () => {
            clearTimeout(timer);
            ctl.abort();
        };
    }, [text, wantGravatar, trimmedEmail, endpoint, pinned, uploadSize]);
    async function upload(file) {
        if (!file)
            return;
        setPinned(true);
        setText('');
        try {
            emit(await downscaleImage(file, { size: uploadSize }));
            setStatus({ kind: 'found', source: 'upload' });
        }
        catch {
            emit(null);
            setStatus({ kind: 'error', detail: "couldn't read that file as an image" });
        }
        if (fileRef.current)
            fileRef.current.value = '';
    }
    function clear() {
        setPinned(true);
        setText('');
        setGravatarAsked(false);
        setStatus({ kind: 'idle' });
        emit(null);
    }
    const hint = status.kind === 'looking'
        ? (labels.looking ?? 'Looking up…')
        : status.kind === 'found'
            ? (labels[status.source] ?? SOURCE_LABELS[status.source])
            : status.kind === 'none'
                ? // No Gravatar is the common case, not news; only say so when asked.
                    status.source === 'gravatar' && autoGravatar
                        ? null
                        : (labels.none ?? 'No avatar found there')
                : status.kind === 'error'
                    ? status.detail
                    : null;
    return (_jsxs("div", { className: classNames.field, children: [_jsxs("div", { className: classNames.row, style: { display: 'flex', alignItems: 'center', gap: '0.5em' }, children: [preview && (_jsx("span", { className: classNames.preview, children: _jsx(Avatar, { src: value, name: name, size: size }) })), _jsx("input", { className: classNames.input, id: id, type: "text", inputMode: "url", autoComplete: "off", spellCheck: false, placeholder: labels.placeholder ?? 'GitHub, Bluesky, or Mastodon profile, image URL, or website', value: text, onChange: e => {
                            setPinned(false);
                            setText(e.target.value);
                        } }), _jsx("button", { className: classNames.button, type: "button", onClick: () => fileRef.current?.click(), children: labels.upload ?? 'Upload…' }), !autoGravatar && EMAILISH.test(trimmedEmail) && !text.trim() && (_jsx("button", { className: classNames.button, type: "button", onClick: () => {
                            setPinned(false);
                            setGravatarAsked(true);
                        }, children: labels.gravatar ?? 'Use Gravatar' })), (value || text) && (_jsx("button", { className: classNames.button, type: "button", onClick: clear, children: labels.clear ?? 'Clear' })), _jsx("input", { ref: fileRef, type: "file", accept: "image/png,image/jpeg,image/webp,image/gif,image/svg+xml", hidden: true, onChange: e => void upload(e.target.files?.[0]) })] }), hint && (_jsx("span", { className: classNames.hint, role: status.kind === 'error' ? 'alert' : undefined, children: hint }))] }));
}
