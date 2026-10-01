/**
 * Faces for share links and profiles — always *copied*, never hotlinked.
 *
 * The point isn't decoration: a link that renders "Bob Smith" with Bob's face
 * is visibly *wrong* to whoever Bob forwards it to, which is the cheapest
 * discouragement of forwarding there is — and it costs nothing, because the
 * admin minting the link already knows who it's for.
 *
 * Every source (a profile URL, a handle, an image URL, an uploaded file, a
 * Gravatar) is fetched **once**, server-side, sniffed as a real raster image,
 * and stored as a `data:` URI or an `AssetStore` object. A live third-party URL
 * is never persisted, because:
 *
 * - rendering one tells its host that this person opened this private page,
 *   on every view;
 * - some hosts sign their image URLs with an expiry (LinkedIn's `media.licdn.com`
 *   does), so a stored link silently stops rendering weeks later;
 * - it resolves once instead of on every page view.
 *
 * Profile pages are recognized for the networks with a public, unauthenticated
 * way to get a face (GitHub, Bluesky, Mastodon); the ones without (LinkedIn,
 * X, Facebook, …) are refused by name, with a pointer to the image address or
 * an upload instead of a scrape that would break.
 */
/** Cap on an inlined image. Grants are read on every request for a link. */
export const MAX_INLINE_AVATAR_BYTES = 64 * 1024;
/**
 * Cap on what the preview endpoint hands the browser, which downscales it
 * before anything is stored (`<AvatarField>`). Generous, because some sources
 * only serve originals: Mastodon's API has no thumbnail, and 400 KB avatars are
 * common there.
 */
export const MAX_PREVIEW_AVATAR_BYTES = 2 * 1024 * 1024;
/** Some hosts (Wikimedia, for one) refuse requests without one. */
const USER_AGENT = '@open-athena/auth avatar copy (+https://github.com/Open-Athena/auth)';
/** Square pixels asked of providers that take a size. Rendered faces are ≤64px; this is 2× headroom. */
export const DEFAULT_AVATAR_SIZE = 128;
/** Thrown when a source can't yield an acceptable image; the message is fit for an admin to read. */
export class InvalidImageError extends Error {
    constructor(message) {
        super(message);
        this.name = 'InvalidImageError';
    }
}
/** GitHub's own rules: alphanumeric or single hyphens, not leading/trailing, ≤39. */
const GITHUB_HANDLE = /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/;
export function isGithubHandle(handle) {
    return GITHUB_HANDLE.test(handle);
}
/**
 * `https:` only, and no credentials in the URL — the precondition for fetching
 * an IdP-supplied `picture` claim at all.
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
/** A DNS name with at least one dot, each label LDH — what a Bluesky handle or Mastodon instance is. */
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/i;
const BSKY_DID = /^did:(?:plc:[a-z2-7]{24}|web:[a-z0-9.-]+)$/;
const MASTODON_USER = /^[a-z0-9_]{1,30}$/i;
/** Paths under github.com that are site pages, not people. */
const GITHUB_RESERVED = new Set(['orgs', 'settings', 'about', 'features', 'login', 'join', 'explore', 'marketplace', 'sponsors', 'topics', 'search', 'notifications']);
/**
 * Networks with no public way to fetch someone's face: no API without app review
 * or payment, and a login wall in front of the profile page. Named, so the
 * refusal can say what to do instead.
 */
const NO_PUBLIC_AVATAR = {
    'linkedin.com': 'LinkedIn',
    'x.com': 'X',
    'twitter.com': 'X',
    'facebook.com': 'Facebook',
    'fb.com': 'Facebook',
    'instagram.com': 'Instagram',
    'threads.net': 'Threads',
    'threads.com': 'Threads',
    'tiktok.com': 'TikTok',
    'youtube.com': 'YouTube',
    'medium.com': 'Medium',
};
const hostIs = (host, domain) => host === domain || host.endsWith(`.${domain}`);
/**
 * Parse what an admin pastes into an avatar field. Accepts:
 *
 * - a GitHub profile URL or bare handle (`torvalds`, `@torvalds`);
 * - a Bluesky profile URL (`bsky.app/profile/<handle|did>`) or bare handle
 *   (`alice.bsky.social`);
 * - a Mastodon profile URL (`https://<instance>/@<user>`) or address
 *   (`@user@instance`);
 * - a `data:image/…;base64,` URI (an upload, or a preview handed back);
 * - any other `https:` URL, taken as a direct image address.
 *
 * Throws `InvalidImageError` for anything else, including profile pages of
 * networks with no public avatar (see `NO_PUBLIC_AVATAR`).
 */
export function parseAvatarRef(input) {
    const s = input.trim();
    if (!s)
        throw new InvalidImageError('empty avatar reference');
    if (s.startsWith('data:'))
        return { kind: 'upload', bytes: dataUriBytes(s) };
    if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) {
        const mastodon = /^@?([^@\s]+)@([^@\s]+)$/.exec(s);
        if (mastodon) {
            const [, user, instance] = mastodon;
            if (MASTODON_USER.test(user) && DOMAIN.test(instance))
                return { kind: 'mastodon', user, instance: instance.toLowerCase() };
            throw new InvalidImageError(`not a Mastodon address: ${s}`);
        }
        const bare = s.replace(/^@/, '');
        if (isGithubHandle(bare))
            return { kind: 'github', handle: bare };
        if (DOMAIN.test(bare))
            return { kind: 'bluesky', actor: bare.toLowerCase() };
        throw new InvalidImageError(`not a profile URL, handle, or image URL: ${s}`);
    }
    let url;
    try {
        url = new URL(s);
    }
    catch {
        throw new InvalidImageError(`not a valid URL: ${s}`);
    }
    if (url.protocol !== 'https:')
        throw new InvalidImageError('only https: URLs are fetched');
    if (url.username || url.password)
        throw new InvalidImageError('URLs with credentials are refused');
    if (s.length > 2048)
        throw new InvalidImageError('URL too long');
    const host = url.hostname.toLowerCase();
    const path = url.pathname.split('/').filter(Boolean);
    if (host === 'github.com' || host === 'www.github.com') {
        const [handle] = path;
        if (path.length >= 1 && handle && isGithubHandle(handle) && !GITHUB_RESERVED.has(handle.toLowerCase())) {
            // `github.com/<handle>.png` is itself an image URL GitHub serves.
            return { kind: 'github', handle };
        }
        const png = handle?.endsWith('.png') ? handle.slice(0, -4) : null;
        if (path.length === 1 && png && isGithubHandle(png))
            return { kind: 'github', handle: png };
        throw new InvalidImageError('a GitHub URL should be a profile: github.com/<handle>');
    }
    if (host === 'bsky.app' && path[0] === 'profile' && path[1]) {
        const actor = decodeURIComponent(path[1]).toLowerCase();
        if (DOMAIN.test(actor) || BSKY_DID.test(actor))
            return { kind: 'bluesky', actor };
        throw new InvalidImageError(`not a Bluesky handle: ${path[1]}`);
    }
    const site = Object.entries(NO_PUBLIC_AVATAR).find(([d]) => hostIs(host, d))?.[1];
    // An image *on* one of these networks' CDNs is fine (that's the workaround);
    // only their profile pages are refused, and their CDNs are separate hosts.
    if (site) {
        throw new InvalidImageError(`${site} has no public way to fetch a profile photo; open it, copy the image address (or save it and upload), and use that`);
    }
    if (path.length === 1 && /^@[a-z0-9_]{1,30}$/i.test(path[0]) && !url.search) {
        return { kind: 'mastodon', user: path[0].slice(1), instance: host };
    }
    return { kind: 'url', url: url.href };
}
/** Decode a `data:<type>;base64,<payload>` URI; the type is ignored (bytes are sniffed). */
function dataUriBytes(uri) {
    const m = /^data:[^,;]*(?:;[^,;]*)*;base64,([A-Za-z0-9+/=\s]*)$/.exec(uri);
    if (!m)
        throw new InvalidImageError('only base64 data: URIs are accepted');
    try {
        return Uint8Array.from(atob(m[1].replace(/\s/g, '')), c => c.charCodeAt(0));
    }
    catch {
        throw new InvalidImageError('malformed base64 in data: URI');
    }
}
const hex = (buf) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
/**
 * Gravatar's key is `SHA-256(trim(lowercase(email)))`. `d=404` is what makes
 * this a *lookup*: without it Gravatar always answers with a generated image,
 * and "has an avatar" becomes unknowable.
 */
export async function gravatarUrl(email, size = DEFAULT_AVATAR_SIZE) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(email.trim().toLowerCase()));
    return `https://gravatar.com/avatar/${hex(digest)}?s=${size}&d=404`;
}
/** GitHub redirects this to the CDN, and 404s for a handle nobody has. */
export function githubAvatarUrl(handle, size = DEFAULT_AVATAR_SIZE) {
    return `https://github.com/${encodeURIComponent(handle)}.png?size=${size}`;
}
/**
 * Fetch the image a ref points at and validate it as a raster image.
 *
 * `null` means "this person has no avatar there" (a Gravatar/GitHub 404, a
 * Bluesky or Mastodon profile with no picture) — a real answer, not a failure:
 * `<Avatar>` falls back to initials. Anything that *should* have produced an
 * image and didn't (an unreachable URL, an HTML page, an SVG, an oversized
 * file, an unknown profile) throws `InvalidImageError`.
 */
export async function fetchAvatar(ref, opts = {}) {
    const { size = DEFAULT_AVATAR_SIZE, maxBytes = MAX_INLINE_AVATAR_BYTES, fetch = globalThis.fetch } = opts;
    switch (ref.kind) {
        case 'upload':
            return validateUploadedImage(ref.bytes, { maxBytes });
        case 'gravatar':
            return await fetchImage(await gravatarUrl(ref.email, size), { maxBytes, fetch, missing: 'null' });
        case 'github':
            if (!isGithubHandle(ref.handle))
                throw new InvalidImageError(`not a GitHub handle: ${ref.handle}`);
            return await fetchImage(githubAvatarUrl(ref.handle, size), { maxBytes, fetch, missing: 'null' });
        case 'bluesky': {
            const api = `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(ref.actor)}`;
            const profile = await fetchJson(api, fetch);
            if (!profile)
                throw new InvalidImageError(`no Bluesky profile ${ref.actor}`);
            if (!profile.avatar)
                return null;
            // The CDN serves presets; `avatar` is the ~1000px original, the
            // thumbnail preset is plenty for a face and an order of magnitude smaller.
            const thumb = profile.avatar.replace('/img/avatar/', '/img/avatar_thumbnail/');
            return await fetchImage(thumb, { maxBytes, fetch, missing: 'throw' });
        }
        case 'mastodon': {
            const api = `https://${ref.instance}/api/v1/accounts/lookup?acct=${encodeURIComponent(ref.user)}`;
            const account = await fetchJson(api, fetch);
            if (!account)
                throw new InvalidImageError(`no Mastodon account @${ref.user}@${ref.instance}`);
            // Instances serve a stock "missing" image rather than nothing; that's
            // initials territory, not a face.
            if (!account.avatar_static || /\/avatars\/original\/missing\.png$/.test(account.avatar_static))
                return null;
            return await fetchImage(account.avatar_static, { maxBytes, fetch, missing: 'throw' });
        }
        case 'url':
            return await fetchImage(ref.url, { maxBytes, fetch, missing: 'throw' });
    }
}
async function fetchJson(url, fetch) {
    const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': USER_AGENT } }).catch(() => null);
    if (!res)
        throw new InvalidImageError(`could not reach ${new URL(url).host}`);
    if (!res.ok)
        return null;
    return (await res.json().catch(() => null));
}
async function fetchImage(url, { maxBytes, fetch, missing }) {
    if (!url.startsWith('https://'))
        throw new InvalidImageError('only https: images are fetched');
    const res = await fetch(url, { redirect: 'follow', headers: { accept: 'image/*', 'user-agent': USER_AGENT } }).catch(() => null);
    if (!res)
        throw new InvalidImageError(`could not reach ${new URL(url).host}`);
    if (res.status === 404 && missing === 'null')
        return null;
    if (!res.ok)
        throw new InvalidImageError(`fetching the image failed (HTTP ${res.status})`);
    const declared = Number(res.headers.get('content-length'));
    if (declared > maxBytes)
        throw tooBig(declared, maxBytes);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const type = res.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
    if (type === 'text/html') {
        throw new InvalidImageError('that URL is a web page, not an image; copy the image address instead (or save it and upload)');
    }
    return validateUploadedImage(bytes, { maxBytes });
}
const tooBig = (n, cap) => new InvalidImageError(`image is ${Math.ceil(n / 1024)} KB, over the ${Math.floor(cap / 1024)} KB cap; save it and upload instead (uploads are downscaled)`);
/** Base64-encode raw image bytes into a `data:` URI. Not URL-safe base64 — a data URI wants standard. */
export function bytesToDataUri(type, bytes) {
    let binary = '';
    for (const b of bytes)
        binary += String.fromCharCode(b);
    return `data:${type};base64,${btoa(binary)}`;
}
/** Largest edge a self-set avatar may claim, so a decoder isn't handed a bomb. */
export const MAX_AVATAR_DIMENSION = 8192;
/**
 * Accept raw bytes as an avatar, or throw {@link InvalidImageError}.
 *
 * The content type is decided by **magic-number sniff**, never a caller-supplied
 * header: a `text/html` polyglot labelled `image/png`, or an SVG (which is
 * scriptable), must not pass. Only `image/{png,jpeg,webp,gif}` are recognized,
 * and each is parsed far enough to read its dimensions — a real header, not four
 * lucky bytes followed by garbage — which are then range-checked.
 *
 * Bytes are not re-encoded or EXIF-stripped server-side (that needs an image
 * codec in a Worker); `<AvatarField>` downscales uploads in the browser, which
 * re-encodes them and drops metadata on the way.
 */
export function validateUploadedImage(bytes, { maxBytes = MAX_INLINE_AVATAR_BYTES } = {}) {
    if (!bytes.length)
        throw new InvalidImageError('empty image');
    if (bytes.length > maxBytes)
        throw tooBig(bytes.length, maxBytes);
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
