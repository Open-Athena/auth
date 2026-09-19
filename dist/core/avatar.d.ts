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
export declare const MAX_INLINE_AVATAR_BYTES: number;
export interface AvatarSource {
    /** Looked up on Gravatar, which is keyed by a hash of the address. */
    email?: string | null;
    /** A GitHub handle (not a URL). */
    github?: string | null;
    /** An explicit image URL, which wins over the other two. */
    url?: string | null;
}
export interface ResolveAvatarOptions {
    /** Square pixels requested from the provider. Default 128. */
    size?: number;
    /**
     * Fetch the image and return a `data:` URI instead of a URL. Removes the
     * third-party request from the recipient's browser entirely, at the cost of
     * a few KB on the grant row. Default false.
     */
    inline?: boolean;
    maxBytes?: number;
    /** Injectable for tests. */
    fetch?: typeof globalThis.fetch;
}
export declare function isGithubHandle(handle: string): boolean;
/**
 * `https:` only, and no credentials in the URL. This value ends up as an
 * `<img src>` on an admin's screen and on every recipient's page.
 */
export declare function isSafeAvatarUrl(url: string): boolean;
/**
 * Gravatar's key is `SHA-256(trim(lowercase(email)))`. `d=404` is what makes
 * this a *lookup*: without it Gravatar always answers with a generated image,
 * and "has an avatar" becomes unknowable.
 */
export declare function gravatarUrl(email: string, size?: number): Promise<string>;
/** GitHub redirects this to the CDN, and 404s for a handle nobody has. */
export declare function githubAvatarUrl(handle: string, size?: number): string;
/**
 * The best avatar for a person, or `null` if there is none — which is a real
 * answer, not a failure: `<Avatar>` falls back to initials.
 */
export declare function resolveAvatar(source: AvatarSource, { size, inline, maxBytes, fetch }?: ResolveAvatarOptions): Promise<string | null>;
/** Base64-encode raw image bytes into a `data:` URI. Not URL-safe base64 — a data URI wants standard. */
export declare function bytesToDataUri(type: string, bytes: Uint8Array): string;
/** Thrown by {@link validateUploadedImage} when raw bytes are not an acceptable image. */
export declare class InvalidImageError extends Error {
    constructor(message: string);
}
export interface ValidatedImage {
    /** The sniffed content type — `image/png`, `image/jpeg`, `image/webp`, `image/gif`. */
    type: string;
    bytes: Uint8Array;
}
/** Largest edge a self-set avatar may claim, so a decoder isn't handed a bomb. */
export declare const MAX_AVATAR_DIMENSION = 8192;
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
export declare function validateUploadedImage(bytes: Uint8Array, { maxBytes }?: {
    maxBytes?: number;
}): ValidatedImage;
