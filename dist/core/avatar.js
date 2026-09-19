/**
 * Faces for share links, resolved once when the link is minted.
 *
 * The point isn't decoration: a link that renders "Bob Smith" with Bob's face
 * is visibly *wrong* to whoever Bob forwards it to, which is the cheapest
 * discouragement of forwarding there is — and it costs nothing, because the
 * admin minting the link already knows who it's for.
 *
 * Resolution happens at mint time, on the server, deliberately:
 *
 * - hashing the recipient's address in *their* browser on every render would
 *   tell a third party that this person opened this private page, every time;
 * - the admin is a trusted supplier, unlike the stranger filling in the
 *   request form (see `cleanSubject`, which refuses an avatar outright);
 * - it resolves once instead of on every page view.
 *
 * Only two fixed hosts are ever fetched, so this is not an SSRF surface: a
 * caller-supplied `url` is validated and returned, never dereferenced here.
 */
/** Cap on an inlined image. Grants are read on every request for a link. */
export const MAX_INLINE_AVATAR_BYTES = 64 * 1024;
/** GitHub's own rules: alphanumeric or single hyphens, not leading/trailing, ≤39. */
const GITHUB_HANDLE = /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/;
export function isGithubHandle(handle) {
    return GITHUB_HANDLE.test(handle);
}
/**
 * `https:` only, and no credentials in the URL. This value ends up as an
 * `<img src>` on an admin's screen and on every recipient's page.
 */
export function isSafeAvatarUrl(url) {
    if (url.length > 2048)
        return false;
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch {
        return false;
    }
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password;
}
const hex = (buf) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
/**
 * Gravatar's key is `SHA-256(trim(lowercase(email)))`. `d=404` is what makes
 * this a *lookup*: without it Gravatar always answers with a generated image,
 * and "has an avatar" becomes unknowable.
 */
export async function gravatarUrl(email, size = 128) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(email.trim().toLowerCase()));
    return `https://gravatar.com/avatar/${hex(digest)}?s=${size}&d=404`;
}
/** GitHub redirects this to the CDN, and 404s for a handle nobody has. */
export function githubAvatarUrl(handle, size = 128) {
    return `https://github.com/${encodeURIComponent(handle)}.png?size=${size}`;
}
/**
 * The best avatar for a person, or `null` if there is none — which is a real
 * answer, not a failure: `<Avatar>` falls back to initials.
 */
export async function resolveAvatar(source, { size = 128, inline = false, maxBytes = MAX_INLINE_AVATAR_BYTES, fetch = globalThis.fetch } = {}) {
    const url = await candidate(source, size);
    if (!url)
        return null;
    // An explicit URL is the admin's assertion, not a lookup: don't second-guess
    // it with a probe that a hotlink-protected host would fail anyway.
    if (url === source.url)
        return inline ? await inlineImage(url, maxBytes, fetch) : url;
    if (inline)
        return await inlineImage(url, maxBytes, fetch);
    const res = await fetch(url, { method: 'GET', redirect: 'follow' }).catch(() => null);
    return res?.ok ? url : null;
}
async function candidate(source, size) {
    if (source.url)
        return isSafeAvatarUrl(source.url) ? source.url : null;
    if (source.github)
        return isGithubHandle(source.github) ? githubAvatarUrl(source.github, size) : null;
    if (source.email)
        return await gravatarUrl(source.email, size);
    return null;
}
async function inlineImage(url, maxBytes, fetch) {
    const res = await fetch(url, { redirect: 'follow' }).catch(() => null);
    if (!res?.ok)
        return null;
    const type = res.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
    // Anything that isn't an image would be inlined into an `<img src>` on an
    // admin's page; refuse rather than hope the browser is careful.
    if (!type.startsWith('image/') || type === 'image/svg+xml')
        return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!bytes.length || bytes.length > maxBytes)
        return null;
    return bytesToDataUri(type, bytes);
}
/** Base64-encode raw image bytes into a `data:` URI. Not URL-safe base64 — a data URI wants standard. */
export function bytesToDataUri(type, bytes) {
    let binary = '';
    for (const b of bytes)
        binary += String.fromCharCode(b);
    return `data:${type};base64,${btoa(binary)}`;
}
/** Thrown by {@link validateUploadedImage} when raw bytes are not an acceptable image. */
export class InvalidImageError extends Error {
    constructor(message) {
        super(message);
        this.name = 'InvalidImageError';
    }
}
/** Largest edge a self-set avatar may claim, so a decoder isn't handed a bomb. */
export const MAX_AVATAR_DIMENSION = 8192;
/**
 * Accept raw uploaded bytes as an avatar, or throw {@link InvalidImageError}.
 *
 * The content type is decided by **magic-number sniff**, never a caller-supplied
 * header: a `text/html` polyglot labelled `image/png`, or an SVG (which is
 * scriptable), must not pass. Only `image/{png,jpeg,webp,gif}` are recognized,
 * and each is parsed far enough to read its dimensions — a real header, not four
 * lucky bytes followed by garbage — which are then range-checked.
 *
 * v1 does **not** re-encode or strip EXIF (that needs an image codec in a
 * Worker); sniff-and-cap already closes the SVG-script and mislabel holes, which
 * are the ones that turn an avatar into an attack. Re-encode is a later add if a
 * consumer needs GPS/metadata stripped.
 */
export function validateUploadedImage(bytes, { maxBytes = MAX_INLINE_AVATAR_BYTES } = {}) {
    if (!bytes.length)
        throw new InvalidImageError('empty upload');
    if (bytes.length > maxBytes)
        throw new InvalidImageError(`image is ${bytes.length} bytes, over the ${maxBytes} cap`);
    const sniffed = sniffImage(bytes);
    if (!sniffed)
        throw new InvalidImageError('not a supported image (png, jpeg, webp, or gif)');
    const { type, width, height } = sniffed;
    if (width <= 0 || height <= 0 || width > MAX_AVATAR_DIMENSION || height > MAX_AVATAR_DIMENSION) {
        throw new InvalidImageError(`implausible dimensions ${width}x${height}`);
    }
    return { type, bytes };
}
const startsWith = (bytes, sig) => bytes.length >= sig.length && sig.every((b, i) => bytes[i] === b);
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/**
 * Sniff a known image format and read its dimensions from the header. `null`
 * for anything unrecognized — which is how SVG, text and truncated files are
 * refused: none of them carry one of these binary signatures.
 */
function sniffImage(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // PNG: 8-byte signature, then an IHDR chunk whose width/height are big-endian
    // uint32s at bytes 16 and 20.
    if (startsWith(bytes, PNG_SIG)) {
        if (bytes.length < 24)
            return null;
        return { type: 'image/png', width: view.getUint32(16), height: view.getUint32(20) };
    }
    // GIF: "GIF87a"/"GIF89a", then little-endian uint16 width/height at bytes 6/8.
    if ((startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))) {
        if (bytes.length < 10)
            return null;
        return { type: 'image/gif', width: view.getUint16(6, true), height: view.getUint16(8, true) };
    }
    // JPEG: SOI (FFD8), then walk the marker segments to the frame header (SOFn),
    // whose height/width are big-endian uint16s. The scan bounds this to the
    // header; the entropy-coded image data is never touched.
    if (startsWith(bytes, [0xff, 0xd8])) {
        const dims = jpegDimensions(bytes, view);
        return dims ? { type: 'image/jpeg', ...dims } : null;
    }
    // WebP: RIFF container ("RIFF"…"WEBP") with a VP8/VP8L/VP8X chunk.
    if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && bytes.length >= 16 && startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])) {
        const dims = webpDimensions(bytes, view);
        return dims ? { type: 'image/webp', ...dims } : null;
    }
    return null;
}
function jpegDimensions(bytes, view) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
        if (bytes[offset] !== 0xff)
            return null;
        const marker = bytes[offset + 1];
        // SOF0..SOF15 carry the frame dimensions; C4/C8/CC are not frame headers.
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
            return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
        }
        // Standalone markers (RSTn, SOI, EOI) carry no length; everything else does.
        offset += 2 + view.getUint16(offset + 2);
    }
    return null;
}
function webpDimensions(bytes, view) {
    const fourcc = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
    if (fourcc === 'VP8X') {
        // Extended: 24-bit little-endian (value + 1) at bytes 24 (width) and 27.
        if (bytes.length < 30)
            return null;
        const w = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
        const h = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
        return { width: w, height: h };
    }
    if (fourcc === 'VP8 ') {
        // Lossy: 16-bit little-endian width/height (low 14 bits) after the 3-byte
        // start code at byte 26.
        if (bytes.length < 30)
            return null;
        return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
    }
    if (fourcc === 'VP8L') {
        // Lossless: 14-bit (value - 1) fields packed after the 0x2f signature byte.
        if (bytes.length < 25 || bytes[20] !== 0x2f)
            return null;
        const b = view.getUint32(21, true);
        return { width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff) };
    }
    return null;
}
