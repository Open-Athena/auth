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
export declare const MAX_INLINE_AVATAR_BYTES: number;
/**
 * Cap on what the preview endpoint hands the browser, which downscales it
 * before anything is stored (`<AvatarField>`). Generous, because some sources
 * only serve originals: Mastodon's API has no thumbnail, and 400 KB avatars are
 * common there.
 */
export declare const MAX_PREVIEW_AVATAR_BYTES: number;
/** Square pixels asked of providers that take a size. Rendered faces are ≤64px; this is 2× headroom. */
export declare const DEFAULT_AVATAR_SIZE = 128;
/** Where a face comes from, once parsed. */
export type AvatarRef = {
    kind: 'github';
    handle: string;
} | {
    kind: 'bluesky';
    actor: string;
} | {
    kind: 'mastodon';
    user: string;
    instance: string;
} | {
    kind: 'gravatar';
    email: string;
}
/** A direct image URL, fetched once and copied. */
 | {
    kind: 'url';
    url: string;
}
/** Bytes already in hand: an upload, or a `data:` URI from a preview. */
 | {
    kind: 'upload';
    bytes: Uint8Array;
};
export type AvatarRefKind = AvatarRef['kind'];
/** Thrown when a source can't yield an acceptable image; the message is fit for an admin to read. */
export declare class InvalidImageError extends Error {
    constructor(message: string);
}
export declare function isGithubHandle(handle: string): boolean;
/**
 * `https:` only, and no credentials in the URL — the precondition for fetching
 * an IdP-supplied `picture` claim at all.
 */
export declare function isSafeAvatarUrl(url: string): boolean;
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
export declare function parseAvatarRef(input: string): AvatarRef;
/**
 * Gravatar's key is `SHA-256(trim(lowercase(email)))`. `d=404` is what makes
 * this a *lookup*: without it Gravatar always answers with a generated image,
 * and "has an avatar" becomes unknowable.
 */
export declare function gravatarUrl(email: string, size?: number): Promise<string>;
/** GitHub redirects this to the CDN, and 404s for a handle nobody has. */
export declare function githubAvatarUrl(handle: string, size?: number): string;
export interface FetchAvatarOptions {
    /** Square pixels asked of providers that take a size. Default `DEFAULT_AVATAR_SIZE`. */
    size?: number;
    /** Byte cap on the copied image. Default `MAX_INLINE_AVATAR_BYTES`. */
    maxBytes?: number;
    /** Injectable for tests, and for a timeout wrapper. */
    fetch?: typeof globalThis.fetch;
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
export declare function fetchAvatar(ref: AvatarRef, opts?: FetchAvatarOptions): Promise<ValidatedImage | null>;
/** Base64-encode raw image bytes into a `data:` URI. Not URL-safe base64 — a data URI wants standard. */
export declare function bytesToDataUri(type: string, bytes: Uint8Array): string;
export interface ValidatedImage {
    /** The sniffed content type — `image/png`, `image/jpeg`, `image/webp`, `image/gif`. */
    type: string;
    bytes: Uint8Array;
}
/** Largest edge a self-set avatar may claim, so a decoder isn't handed a bomb. */
export declare const MAX_AVATAR_DIMENSION = 8192;
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
export declare function validateUploadedImage(bytes: Uint8Array, { maxBytes }?: {
    maxBytes?: number;
}): ValidatedImage;
