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
