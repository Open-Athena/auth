import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useRef, useState } from 'react';
import { Avatar } from './Avatar.js';
const SOURCE_LABELS = {
    github: 'From GitHub',
    bluesky: 'From Bluesky',
    mastodon: 'From Mastodon',
    gravatar: 'From Gravatar',
    url: 'From image URL',
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
                setStatus({ kind: 'error', detail: 'lookup failed' });
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
    return (_jsxs("div", { className: classNames.field, children: [_jsxs("div", { className: classNames.row, style: { display: 'flex', alignItems: 'center', gap: '0.5em' }, children: [preview && (_jsx("span", { className: classNames.preview, children: _jsx(Avatar, { src: value, name: name, size: size }) })), _jsx("input", { className: classNames.input, id: id, type: "text", inputMode: "url", autoComplete: "off", spellCheck: false, placeholder: labels.placeholder ?? 'GitHub, Bluesky, or Mastodon profile, or image URL', value: text, onChange: e => {
                            setPinned(false);
                            setText(e.target.value);
                        } }), _jsx("button", { className: classNames.button, type: "button", onClick: () => fileRef.current?.click(), children: labels.upload ?? 'Upload…' }), !autoGravatar && EMAILISH.test(trimmedEmail) && !text.trim() && (_jsx("button", { className: classNames.button, type: "button", onClick: () => {
                            setPinned(false);
                            setGravatarAsked(true);
                        }, children: labels.gravatar ?? 'Use Gravatar' })), (value || text) && (_jsx("button", { className: classNames.button, type: "button", onClick: clear, children: labels.clear ?? 'Clear' })), _jsx("input", { ref: fileRef, type: "file", accept: "image/png,image/jpeg,image/webp,image/gif", hidden: true, onChange: e => void upload(e.target.files?.[0]) })] }), hint && (_jsx("span", { className: classNames.hint, role: status.kind === 'error' ? 'alert' : undefined, children: hint }))] }));
}
/**
 * `downscaleImage` for a `data:` URI. Where the browser can't decode or
 * re-encode (no `createImageBitmap`, as in jsdom), the original passes through
 * and the server's storage cap is the backstop.
 */
async function downscaleDataUri(uri, size) {
    try {
        const [head, b64 = ''] = uri.split(',', 2);
        const type = /^data:([^;,]+)/.exec(head ?? '')?.[1] ?? 'application/octet-stream';
        const blob = new Blob([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], { type });
        return await downscaleImage(blob, { size });
    }
    catch {
        return uri;
    }
}
/**
 * Center-crop an image file to a square and downscale it to at most `size`
 * pixels, in the browser, returning a `data:` URI. No server-side image codec
 * (or Cloudflare Images) needed: re-encoding here keeps uploads small enough to
 * inline, and drops EXIF (GPS included) on the way.
 *
 * WebP where the browser can encode it (keeps transparency); Safari can't, so
 * there it falls back to JPEG over white.
 */
export async function downscaleImage(file, { size = 256, quality = 0.85 } = {}) {
    const bmp = await createImageBitmap(file);
    const side = Math.min(bmp.width, bmp.height);
    const out = Math.min(size, side);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = out;
    const ctx = canvas.getContext('2d');
    if (!ctx)
        throw new Error('no 2d canvas');
    const draw = () => ctx.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, out, out);
    draw();
    const webp = canvas.toDataURL('image/webp', quality);
    if (webp.startsWith('data:image/webp'))
        return webp;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, out, out);
    draw();
    return canvas.toDataURL('image/jpeg', quality);
}
